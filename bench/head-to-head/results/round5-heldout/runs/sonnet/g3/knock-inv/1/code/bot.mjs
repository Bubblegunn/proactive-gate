// Marketing opt-out gate (CAN-SPAM 15 U.S.C. 7704(a)(4), Gmail/Yahoo bulk sender rules).
// - An unsubscribe blocks every marketing email, including agent-queued ones, at once.
// - Transactional email (receipts, password resets) is never blocked by an unsubscribe.
// - The newest event by provider time wins; on an exact tie the unsubscribe wins.
// State: one append-only file per address in STATE_DIR, so workers and restarts share it.
import { appendFileSync, readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

function normalize(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1];
  s = s.trim().replace(/^mailto:/i, '').split('?')[0].trim().replace(/^<|>$/g, '').trim();
  s = s.toLowerCase();
  const at = s.lastIndexOf('@');
  if (at < 1 || at === s.length - 1 || /\s/.test(s)) return null;
  return s;
}

function fileFor(addr) {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  mkdirSync(dir, { recursive: true });
  return join(dir, createHash('sha256').update(addr).digest('hex') + '.log');
}

function time(at, fallbackNow) {
  const t = at instanceof Date ? at.getTime() : new Date(at).getTime();
  return Number.isFinite(t) ? t : fallbackNow ? Date.now() : null;
}

function record(type, email, at) {
  const addr = normalize(email);
  if (!addr) return;
  // A bad timestamp on an unsubscribe still counts, as of now. A bad one on a resubscribe is ignored.
  const t = time(at, type === 'u');
  if (t === null) return;
  appendFileSync(fileFor(addr), `${type} ${t}\n`, { flag: 'a' }); // one small O_APPEND write per event
}

export function recordUnsubscribe(email, at) { record('u', email, at); }
export function recordResubscribe(email, at) { record('r', email, at); }

function suppressed(addr) {
  let text;
  try { text = readFileSync(fileFor(addr), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  let u = -Infinity, r = -Infinity;
  for (const line of text.split('\n')) {
    const [type, n] = line.split(' ');
    const t = Number(n);
    if (!Number.isFinite(t)) continue;
    if (type === 'u') u = Math.max(u, t);
    else if (type === 'r') r = Math.max(r, t);
  }
  return u > -Infinity && u >= r;
}

export function mayEmail(message, now) {
  if (message && message.kind === 'transactional') return { allowed: true, reason: null };
  // Anything not clearly transactional is treated as marketing.
  const addr = normalize(message && message.to);
  if (!addr) return { allowed: false, reason: 'invalid_address' };
  if (suppressed(addr)) return { allowed: false, reason: 'unsubscribed' };
  return { allowed: true, reason: null };
}
