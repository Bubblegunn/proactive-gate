// Email send gate for the shop's marketing and transactional mail.
//
// Shared state lives in $STATE_DIR/optout-events/<sha256(address)>.log.
// Each unsubscribe or resubscribe event is appended as one JSON line.
// The opt-out status is derived from the latest timestamps in those lines,
// so the result does not depend on arrival order, duplicates, or which
// worker wrote an event. Appends use O_APPEND and need no lock. A torn
// write (process killed mid-line) is skipped on read because every record
// starts with a newline.
//
// Rules:
// - Marketing mail to an address whose latest unsubscribe is not overridden
//   by a later resubscribe is blocked (reason "unsubscribed").
// - Transactional mail (order receipts, password resets) is never blocked by
//   an opt-out. CAN-SPAM 15 U.S.C. 7702(2) leaves transactional or relationship
//   messages (defined in 7702(17)) out of "commercial electronic mail message",
//   so the opt-out duty in 7704 does not reach them. The recipient also expects
//   them. A message that adds promotional content is commercial and must be
//   sent as "marketing".
// - Unknown kinds and invalid addresses are blocked (fail closed).
// - The `now` argument is accepted for the interface but not used. Opt-out
//   state depends only on the provider's event timestamps, so clock skew
//   between our machine and the provider cannot re-enable a sender.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const KIND_MARKETING = 'marketing';
const KIND_TRANSACTIONAL = 'transactional';
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

function eventsDir() {
  const root = process.env.STATE_DIR;
  if (!root) throw new Error('STATE_DIR is not set');
  return path.join(root, 'optout-events');
}

// Reduce an address to one key per mailbox, so that header and typed variants
// of the same person match. Over-matching is intentional: suppressing a
// mailbox that is also used by someone else is safer than emailing an
// address that opted out.
//   - accepts "Name <<EMAIL>>", "mailto:<EMAIL>", and surrounding whitespace
//   - lowercases the address
//   - converts the domain to ASCII (punycode) and drops a trailing dot
//   - drops "+tag" from the local part on every domain
//   - for gmail.com / googlemail.com, drops dots and maps both to gmail.com
// Returns null when the input is not a usable address.
function canonicalAddress(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  const angle = s.match(/<([^<>]*)>/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, '').trim().toLowerCase();
  if (s === '' || /\s/.test(s)) return null;

  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return null;

  let local = s.slice(0, at).split('+')[0];
  const rawDomain = s.slice(at + 1).replace(/\.$/, '');
  if (/[/\\?#@:[\]]/.test(rawDomain)) return null;
  let domain;
  try {
    domain = new URL(`http://${rawDomain}`).hostname;
  } catch {
    return null;
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return null;
  if (local === '') return null;

  if (GMAIL_DOMAINS.has(domain)) {
    domain = 'gmail.com';
    local = local.replace(/\./g, '');
    if (local === '') return null;
  }
  return `${local}@${domain}`;
}

function fileFor(key) {
  const digest = createHash('sha256').update(key).digest('hex');
  return path.join(eventsDir(), `${digest}.log`);
}

async function appendEvent(email, at, type) {
  const key = canonicalAddress(email);
  if (!key) throw new TypeError('invalid email address');
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new TypeError('at must be a valid Date');
  }

  await fs.mkdir(eventsDir(), { recursive: true });
  // Leading and trailing newlines keep a torn earlier write from merging
  // with this record.
  const line = '\n' + JSON.stringify({ v: 1, type, key, at: at.getTime() }) + '\n';
  const handle = await fs.open(fileFor(key), 'a');
  try {
    let buf = Buffer.from(line, 'utf8');
    while (buf.length > 0) {
      const { bytesWritten } = await handle.write(buf);
      buf = buf.subarray(bytesWritten);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Latest unsubscribe and resubscribe timestamps (ms) for a key, or null.
async function readState(key) {
  let text;
  try {
    text = await fs.readFile(fileFor(key), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { unsub: null, resub: null };
    throw err;
  }

  let unsub = null;
  let resub = null;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // torn write
    }
    if (rec?.key !== key || !Number.isFinite(rec.at)) continue;
    if (rec.type === 'unsubscribe' && (unsub === null || rec.at > unsub)) {
      unsub = rec.at;
    } else if (rec.type === 'resubscribe' && (resub === null || rec.at > resub)) {
      resub = rec.at;
    }
  }
  return { unsub, resub };
}

// A resubscribe only counts if it is strictly later than the latest
// unsubscribe. On an exact tie, the unsubscribe wins.
function isOptedOut({ unsub, resub }) {
  return unsub !== null && (resub === null || resub <= unsub);
}

export async function recordUnsubscribe(email, at) {
  await appendEvent(email, at, 'unsubscribe');
}

export async function recordResubscribe(email, at) {
  await appendEvent(email, at, 'resubscribe');
}

export async function mayEmail(message, now) {
  const kind = message?.kind;
  if (kind !== KIND_MARKETING && kind !== KIND_TRANSACTIONAL) {
    return { allowed: false, reason: 'unknown_kind' };
  }
  const key = canonicalAddress(message?.to);
  if (!key) return { allowed: false, reason: 'invalid_recipient' };

  if (kind === KIND_TRANSACTIONAL) return { allowed: true, reason: null };

  if (isOptedOut(await readState(key))) {
    return { allowed: false, reason: 'unsubscribed' };
  }
  return { allowed: true, reason: null };
}
