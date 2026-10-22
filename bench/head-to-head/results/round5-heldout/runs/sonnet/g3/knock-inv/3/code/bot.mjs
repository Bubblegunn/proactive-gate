// Opt-out gate for marketing email (CAN-SPAM 15 U.S.C. 7704; Gmail/Yahoo bulk sender rules).
// - Marketing mail stops after an unsubscribe and stays stopped until a later, deliberate resubscribe.
// - Transactional mail (receipts, password resets) is not marketing and is never blocked by an opt-out.
// - Events are ordered by the provider's time `at`, not by arrival order. On a tie, unsubscribe wins.
// - State: one append-only file per address in STATE_DIR. Each event is one line written with a single
//   O_APPEND write and fsync, so concurrent workers cannot lose or corrupt events, and restarts lose nothing.
import { createHash } from 'node:crypto';
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function normalizeEmail(raw) {
  let s = String(raw ?? '').normalize('NFKC').trim();
  const angle = s.match(/<([^<>]*)>\s*$/); // "Name <<EMAIL>>" from a header
  if (angle) s = angle[1];
  s = s.trim().replace(/^mailto:/i, '').replace(/^["'<\s]+|["'>\s.,;]+$/g, '');
  const at = s.lastIndexOf('@');
  if (at < 1) return s.toLowerCase();
  return (s.slice(0, at) + '@' + s.slice(at + 1)).toLowerCase();
}

function dirPath() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function fileFor(dir, email) {
  return join(dir, createHash('sha256').update(email).digest('hex') + '.log');
}

function toMs(at, fallbackNow) {
  const ms = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (Number.isFinite(ms)) return ms;
  if (fallbackNow) return Date.now();
  throw new TypeError('invalid event time');
}

function append(type, email, at, fallbackNow) {
  const addr = normalizeEmail(email);
  if (!addr) throw new TypeError('empty email');
  const line = JSON.stringify({ type, email: addr, at: toMs(at, fallbackNow), rec: Date.now() }) + '\n';
  const fd = openSync(fileFor(dirPath(), addr), 'a');
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// An unsubscribe with a bad timestamp is still honored (stamped now). A bad resubscribe is rejected.
export function recordUnsubscribe(email, at) {
  append('unsub', email, at, true);
}

export function recordResubscribe(email, at) {
  append('resub', email, at, false);
}

function isUnsubscribed(email) {
  let text;
  try {
    text = readFileSync(fileFor(dirPath(), email), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  let unsub = -Infinity;
  let resub = -Infinity;
  for (const l of text.split('\n')) {
    if (!l) continue;
    let ev;
    try { ev = JSON.parse(l); } catch { continue; } // torn line: skip it
    if (ev.type === 'unsub') unsub = Math.max(unsub, ev.at);
    else if (ev.type === 'resub') resub = Math.max(resub, ev.at);
  }
  return unsub >= resub && unsub !== -Infinity;
}

export function mayEmail(message, now) {
  if (message && message.kind === 'transactional') return { allowed: true, reason: null };
  // Anything not clearly transactional is treated as marketing. Fail closed if state is unreadable.
  try {
    if (isUnsubscribed(normalizeEmail(message?.to))) return { allowed: false, reason: 'unsubscribed' };
  } catch {
    return { allowed: false, reason: 'opt_out_state_unavailable' };
  }
  return { allowed: true, reason: null };
}
