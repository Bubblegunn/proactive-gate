import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, readdirSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';

// Each unsubscribe/resubscribe event is its own file, written atomically
// (temp file, then rename). Nothing is read-modified-written, so workers never
// overwrite each other. The state is derived on read: the event with the
// latest provider time wins; on an exact tie the unsubscribe wins.

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Accepts "<EMAIL>", "Name <<EMAIL>>", "<<EMAIL>>", "mailto:<EMAIL>", with
// surrounding whitespace or quotes. Returns null when no address is found.
function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1];
  s = s.trim().replace(/^mailto:/i, '').replace(/^["']+|["']+$/g, '').trim();
  const at = s.lastIndexOf('@');
  if (at < 1 || at === s.length - 1 || /[\s<>,;]/.test(s)) return null;
  return s.slice(0, at).toLowerCase() + '@' + s.slice(at + 1).toLowerCase();
}

function userDir(email) {
  const h = createHash('sha256').update(email).digest('hex');
  return join(stateDir(), 'consent', h);
}

function writeEvent(email, kind, ms) {
  const dir = userDir(email);
  mkdirSync(dir, { recursive: true });
  const id = `${String(ms).padStart(16, '0')}-${kind}-${process.pid}-${randomBytes(6).toString('hex')}`;
  const tmp = join(dir, `.tmp-${id}`);
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, JSON.stringify({ email, kind, at: ms }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, join(dir, id));
}

function isUnsubscribed(email) {
  let names;
  try {
    names = readdirSync(userDir(email));
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  let unsub = -Infinity;
  let resub = -Infinity;
  for (const n of names) {
    if (n.startsWith('.')) continue;
    const [ms, kind] = n.split('-');
    const t = Number(ms);
    if (kind === 'unsub' && t > unsub) unsub = t;
    else if (kind === 'resub' && t > resub) resub = t;
  }
  return unsub >= resub && unsub !== -Infinity;
}

export function recordUnsubscribe(email, at) {
  const e = normalizeEmail(email);
  if (!e) throw new TypeError('invalid email address');
  let ms = at instanceof Date ? at.getTime() : NaN;
  // Unusable timestamp: the opt-out must still be honored, so use receipt time.
  if (!Number.isFinite(ms) || ms < 0) ms = Date.now();
  writeEvent(e, 'unsub', ms);
}

export function recordResubscribe(email, at) {
  const e = normalizeEmail(email);
  if (!e) throw new TypeError('invalid email address');
  const ms = at instanceof Date ? at.getTime() : NaN;
  if (!Number.isFinite(ms) || ms < 0) throw new TypeError('invalid resubscribe time');
  writeEvent(e, 'resub', ms);
}

export function mayEmail(message, now) {
  const kind = message && message.kind;
  // Receipts, password resets and other transactional mail are exempt from
  // marketing opt-outs (CAN-SPAM 15 U.S.C. 7702(2)(B), 7704(a)(4)).
  if (kind === 'transactional') return { allowed: true, reason: null };
  if (kind !== 'marketing') return { allowed: false, reason: 'unknown_kind' };
  const e = normalizeEmail(message.to);
  if (!e) return { allowed: false, reason: 'invalid_recipient' };
  if (isUnsubscribed(e)) return { allowed: false, reason: 'unsubscribed' };
  return { allowed: true, reason: null };
}
