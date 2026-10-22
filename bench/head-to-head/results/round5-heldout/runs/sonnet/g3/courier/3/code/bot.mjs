import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Storage: one append-only file per normalized address in STATE_DIR/optout.
// Each event is one JSON line written with a single O_APPEND write and fsync,
// so concurrent workers never overwrite each other and a restart loses nothing.
// The current state is derived on read: the event with the latest provider time
// wins; on an exact tie the unsubscribe wins.

function stateDir() {
  const base = process.env.STATE_DIR;
  if (!base) throw new Error('STATE_DIR is not set');
  const dir = path.join(base, 'optout');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Accepts "<EMAIL>", " <EMAIL> ", "Name <<EMAIL>>", "<<EMAIL>>", "mailto:<EMAIL>".
export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, '').split('?')[0].trim().replace(/^"|"$/g, '');
  s = s.toLowerCase();
  if (!/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(s) && !/^[^\s@<>,;]+@[^\s@<>,;]+$/.test(s)) return null;
  return s;
}

function fileFor(email) {
  const h = crypto.createHash('sha256').update(email).digest('hex');
  return path.join(stateDir(), h + '.jsonl');
}

function toMillis(at) {
  const t = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (!Number.isFinite(t)) throw new TypeError('invalid event time');
  return t;
}

function record(type, email, at) {
  const addr = normalizeEmail(email);
  if (!addr) throw new TypeError('invalid email address');
  const line = JSON.stringify({ type, email: addr, at: toMillis(at) }) + '\n';
  const fd = fs.openSync(fileFor(addr), 'a');
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function recordUnsubscribe(email, at) {
  record('unsubscribe', email, at);
}

export function recordResubscribe(email, at) {
  record('resubscribe', email, at);
}

function isUnsubscribed(addr) {
  let data;
  try {
    data = fs.readFileSync(fileFor(addr), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  let best = null;
  for (const line of data.split('\n')) {
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; } // torn line from a crash
    if (!ev || (ev.type !== 'unsubscribe' && ev.type !== 'resubscribe') || !Number.isFinite(ev.at)) continue;
    if (
      !best ||
      ev.at > best.at ||
      (ev.at === best.at && ev.type === 'unsubscribe')
    ) best = ev;
  }
  return !!best && best.type === 'unsubscribe';
}

export function mayEmail(message, now) {
  const addr = normalizeEmail(message && message.to);
  if (!addr) return { allowed: false, reason: 'invalid_recipient' };
  const kind = message.kind;
  if (kind === 'transactional') return { allowed: true, reason: null }; // receipts, password resets
  if (kind !== 'marketing') return { allowed: false, reason: 'unknown_kind' };
  if (isUnsubscribed(addr)) return { allowed: false, reason: 'unsubscribed' };
  return { allowed: true, reason: null };
}
