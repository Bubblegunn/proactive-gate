import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

// Per-address directory, one immutable file per event (temp file + rename), so
// concurrent workers never overwrite each other. STATE_DIR is read on every call.
function normalize(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1];
  s = s.trim().replace(/^mailto:/i, '').replace(/^["'\s]+|["'\s]+$/g, '').toLowerCase();
  return /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(s) ? s : null;
}

function addrDir(email) {
  const root = process.env.STATE_DIR;
  if (!root) throw new Error('STATE_DIR is not set');
  return join(root, 'email-consent', createHash('sha256').update(email).digest('hex'));
}

function record(type, email, at) {
  const addr = normalize(email);
  if (!addr) throw new Error('invalid email address');
  let ms = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (!Number.isFinite(ms)) {
    if (type === 'resub') return; // cannot order it, so it cannot lift an opt-out
    ms = Date.now();              // an unsubscribe with no usable time still applies
  }
  const dir = addrDir(addr);
  mkdirSync(dir, { recursive: true });
  const name = `${type}-${ms}-${randomBytes(6).toString('hex')}.json`;
  const tmp = join(dir, `.tmp-${randomBytes(6).toString('hex')}`);
  writeFileSync(tmp, JSON.stringify({ type, ms, addr }));
  renameSync(tmp, join(dir, name));
}

export function recordUnsubscribe(email, at) { record('unsub', email, at); }
export function recordResubscribe(email, at) { record('resub', email, at); }

function latest(addr, nowMs) {
  let unsub = -Infinity, resub = -Infinity, files = [];
  try { files = readdirSync(addrDir(addr)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const f of files) {
    const m = f.match(/^(unsub|resub)-(-?\d+)-[0-9a-f]+\.json$/);
    if (!m) continue;
    const ms = Number(m[2]);
    if (m[1] === 'unsub') unsub = Math.max(unsub, ms);
    else if (ms <= nowMs) resub = Math.max(resub, ms); // a future-dated sign-up is not in effect yet
  }
  return { unsub, resub };
}

export function mayEmail(message, now) {
  if (message?.kind === 'transactional') return { allowed: true, reason: null };
  if (message?.kind !== 'marketing') return { allowed: false, reason: 'unknown_message_kind' };
  const addr = normalize(message.to);
  if (!addr) return { allowed: false, reason: 'invalid_address' };
  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  const { unsub, resub } = latest(addr, nowMs);
  // Newest event by the provider clock wins; on a tie the opt-out wins.
  if (unsub > -Infinity && !(resub > unsub)) return { allowed: false, reason: 'unsubscribed' };
  return { allowed: true, reason: null };
}
