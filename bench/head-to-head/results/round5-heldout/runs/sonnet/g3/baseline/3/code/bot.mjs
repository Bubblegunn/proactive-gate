import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Per-address append-only event log in STATE_DIR. Each event is one JSON line
// written with a single O_APPEND write, so concurrent workers never clobber
// each other and there is no read-modify-write. State is derived on read:
// the event with the latest provider time wins; on a tie, unsubscribe wins.

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Accepts "<EMAIL>", " <EMAIL> ", "Name <<EMAIL>>", "<<EMAIL>>", "mailto:<EMAIL>".
export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, '').trim().replace(/^"+|"+$/g, '');
  if (!/^[^\s@<>,;]+@[^\s@<>,;]+$/.test(s)) return null;
  return s.toLowerCase();
}

function fileFor(email) {
  const h = crypto.createHash('sha256').update(email).digest('hex');
  return path.join(stateDir(), `optout-${h}.log`);
}

function append(email, type, at) {
  const line = JSON.stringify({ type, at: at.getTime() }) + '\n';
  const fd = fs.openSync(fileFor(email), 'a');
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function toDate(at, fallbackNow) {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) {
    if (fallbackNow) return new Date();
    throw new Error('invalid event time');
  }
  return d;
}

export function recordUnsubscribe(email, at) {
  const e = normalizeEmail(email);
  if (!e) throw new Error('invalid email address');
  // A bad timestamp must never cause an unsubscribe to be lost.
  append(e, 'unsubscribe', toDate(at, true));
}

export function recordResubscribe(email, at) {
  const e = normalizeEmail(email);
  if (!e) throw new Error('invalid email address');
  append(e, 'resubscribe', toDate(at, false));
}

function isUnsubscribed(email) {
  let text;
  try {
    text = fs.readFileSync(fileFor(email), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  let latest = -Infinity;
  let unsub = false;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.at > latest) {
      latest = ev.at;
      unsub = ev.type === 'unsubscribe';
    } else if (ev.at === latest && ev.type === 'unsubscribe') {
      unsub = true;
    }
  }
  return unsub;
}

export function mayEmail(message, now) {
  // Transactional mail (receipts, password resets) is exempt from opt-outs.
  if (message && message.kind === 'transactional') return { allowed: true, reason: null };
  // Anything else is treated as marketing (fail closed).
  const e = normalizeEmail(message && message.to);
  if (!e) return { allowed: false, reason: 'invalid_address' };
  if (isUnsubscribed(e)) return { allowed: false, reason: 'unsubscribed' };
  return { allowed: true, reason: null };
}
