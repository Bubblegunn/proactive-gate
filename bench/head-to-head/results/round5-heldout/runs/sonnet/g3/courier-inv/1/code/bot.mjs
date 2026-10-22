// Opt-out gate for marketing email (CAN-SPAM 15 U.S.C. 7704, Gmail/Yahoo bulk-sender rules).
//
// Rules:
//  - Marketing mail to an address that has opted out is blocked immediately.
//  - Transactional mail (receipts, password resets) is never blocked by an opt-out.
//    CAN-SPAM exempts it, and people still need it.
//  - Events may arrive late or out of order. The event with the latest provider time `at`
//    decides. On an exact tie the unsubscribe wins (the safe side).
//
// Storage: one small file per event, in STATE_DIR/optouts/<hash of address>/. Each file is
// written to a temp name, fsynced, then renamed, so no worker sees a partial file. Files are
// never modified, so workers need no locks. State is computed from the file names.

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { join } from 'node:path';

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

// "Jane <<EMAIL>>", "mailto:a@b.c", " A@B.C " -> canonical mailbox key.
// Plus-tags are removed and Gmail dots are ignored, so the same mailbox cannot dodge an
// opt-out by spelling. Folding can only suppress more marketing, never transactional mail.
export function normalizeAddress(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, '').replace(/^["']+|["']+$/g, '').trim();
  const at = s.lastIndexOf('@');
  if (at < 1 || at === s.length - 1) return null;
  let local = s.slice(0, at).toLowerCase();
  let domain = s.slice(at + 1).toLowerCase().replace(/\.+$/, '');
  if (!domain || /[\s,;<>]/.test(local + domain)) return null;
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  if (!local) return null;
  return `${local}@${domain}`;
}

function addressDir(key) {
  const h = createHash('sha256').update(key).digest('hex');
  return join(stateDir(), 'optouts', h);
}

function toMillis(at) {
  const ms = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (!Number.isFinite(ms)) throw new Error('invalid event time');
  return ms;
}

function writeEvent(email, at, type) {
  const key = normalizeAddress(email);
  if (!key) throw new Error('invalid email address');
  const ms = toMillis(at);
  const dir = addressDir(key);
  mkdirSync(dir, { recursive: true });
  // Zero-pad so names sort by time. Offset keeps negative times sortable (not expected).
  const name = `${String(ms + 1e14).padStart(16, '0')}.${type}.${randomBytes(6).toString('hex')}.json`;
  const tmp = join(dir, `.tmp-${randomBytes(8).toString('hex')}`);
  const fd = openSync(tmp, 'wx');
  try {
    writeSync(fd, JSON.stringify({ email: key, type, at: ms }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, join(dir, name));
  try { // make the directory entry durable
    const dfd = openSync(dir, 'r');
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
  } catch { /* not supported on every platform */ }
}

function isUnsubscribed(key) {
  let names;
  try {
    names = readdirSync(addressDir(key));
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  let latest = null; // { ms, type }
  for (const n of names) {
    if (n.startsWith('.tmp-')) continue;
    const [ts, type] = n.split('.');
    if (type !== 'unsub' && type !== 'resub') continue;
    const ms = Number(ts);
    if (!Number.isFinite(ms)) continue;
    if (!latest || ms > latest.ms || (ms === latest.ms && type === 'unsub')) latest = { ms, type };
  }
  return latest !== null && latest.type === 'unsub';
}

export function recordUnsubscribe(email, at) {
  writeEvent(email, at, 'unsub');
}

export function recordResubscribe(email, at) {
  writeEvent(email, at, 'resub');
}

export function mayEmail(message, now) {
  const key = normalizeAddress(message?.to);
  if (!key) return { allowed: false, reason: 'invalid_recipient' };
  const kind = message.kind;
  if (kind === 'transactional') return { allowed: true, reason: null };
  if (kind !== 'marketing') return { allowed: false, reason: 'unknown_kind' };
  // `now` is not compared with the opt-out time: an opt-out is honored at once, even if the
  // provider's clock is ahead of ours.
  if (isUnsubscribed(key)) return { allowed: false, reason: 'unsubscribed' };
  return { allowed: true, reason: null };
}
