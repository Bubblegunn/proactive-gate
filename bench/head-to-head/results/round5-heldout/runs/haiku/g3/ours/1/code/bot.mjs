// Email suppression gate. Shared state lives in STATE_DIR, one append-only
// JSON-lines file per person, so every worker process sees the same history.
import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const KINDS = new Set(['marketing', 'transactional']);

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

// Accepts "<EMAIL>" or a header form like `"Jane Doe" <Jane@Example.com>`.
// Returns the lowercased bare address, or null when it is not one address.
function parseAddress(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  const angle = s.match(/<([^<>]*)>/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, '').trim().toLowerCase();
  if (/\s|,|;|<|>/.test(s)) return null;
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return null;
  if (s.slice(0, at).includes('@')) return null;
  if (!s.slice(at + 1).includes('.')) return null;
  return s;
}

// One key per person. Gmail ignores dots and "+tag" parts in the local
// part and treats googlemail.com as gmail.com, so those spellings are the
// same mailbox. Other domains keep the full lowercased address.
function personKey(raw) {
  const addr = parseAddress(raw);
  if (!addr) return null;
  const at = addr.lastIndexOf('@');
  let local = addr.slice(0, at);
  let domain = addr.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.split('+')[0].replace(/\./g, '');
  if (!local) return null;
  return `${local}@${domain}`;
}

function fileFor(dir, key) {
  const hash = createHash('sha256').update(key).digest('hex');
  return join(dir, 'suppression', `${hash}.jsonl`);
}

async function readEvents(key) {
  const dir = stateDir();
  let text;
  try {
    text = await readFile(fileFor(dir, key), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      // A torn write from a crashed worker. Its caller never got an ack, so skipping it is safe.
      continue;
    }
    if (
      ev &&
      ev.person === key &&
      (ev.type === 'unsubscribe' || ev.type === 'resubscribe') &&
      typeof ev.at === 'string' &&
      !Number.isNaN(Date.parse(ev.at))
    ) {
      events.push(ev);
    }
  }
  return events;
}

// The newest event by provider time decides. Events can arrive late, so
// arrival order is ignored. On an exact tie, unsubscribe wins.
function isSuppressed(events) {
  let best = null;
  for (const ev of events) {
    const t = Date.parse(ev.at);
    if (!best || t > best.t || (t === best.t && ev.type === 'unsubscribe')) {
      best = { t, type: ev.type };
    }
  }
  return best !== null && best.type === 'unsubscribe';
}

async function append(type, email, at) {
  const key = personKey(email);
  if (!key) throw new TypeError(`not a valid email address: ${JSON.stringify(email)}`);
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new TypeError('at must be a valid Date');
  }
  const dir = stateDir();
  await mkdir(join(dir, 'suppression'), { recursive: true });
  // Leading newline: if an earlier write was torn, this record still starts on its own line.
  const line =
    '\n' +
    JSON.stringify({ type, person: key, at: at.toISOString(), recordedAt: new Date().toISOString() }) +
    '\n';
  const fh = await open(fileFor(dir, key), 'a');
  try {
    await fh.appendFile(line);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

export async function recordUnsubscribe(email, at) {
  await append('unsubscribe', email, at);
}

export async function recordResubscribe(email, at) {
  await append('resubscribe', email, at);
}

export async function mayEmail(message, now) {
  const key = personKey(message?.to);
  if (!key) return { allowed: false, reason: 'invalid_recipient' };
  const kind = message?.kind;
  if (!KINDS.has(kind)) return { allowed: false, reason: 'unknown_kind' };
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return { allowed: false, reason: 'invalid_time' };
  }

  // Receipts and password resets are expected by the customer and are not
  // promotions, so an unsubscribe does not stop them.
  if (kind === 'transactional') return { allowed: true, reason: null };

  let events;
  try {
    events = await readEvents(key);
  } catch {
    // Fail closed: when suppression state cannot be read, do not send promotions.
    return { allowed: false, reason: 'state_unavailable' };
  }
  if (isSuppressed(events)) return { allowed: false, reason: 'unsubscribed' };
  return { allowed: true, reason: null };
}
