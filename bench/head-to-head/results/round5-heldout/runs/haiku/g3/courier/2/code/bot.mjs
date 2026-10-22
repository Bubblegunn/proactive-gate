// Suppression rules for outgoing email.
//
// State lives in $STATE_DIR/suppression/<sha256 of canonical address>/.
// Each event is one empty file whose NAME carries the data:
//   unsubscribe-<epoch ms>   or   resubscribe-<epoch ms>
// Creating a file is idempotent (repeated webhook deliveries collapse into
// one file) and needs no lock, so any number of workers can record at once.
// The rule is "latest event wins", ties go to unsubscribe. Late or
// out-of-order arrivals therefore give the same answer regardless of order.
//
// Rules (see mayEmail):
//   - transactional mail (receipts, password resets) is always allowed,
//     because recipients expect it and it is not a commercial message.
//   - marketing mail is blocked once the latest event for the person is an
//     unsubscribe. It is blocked immediately, which is stricter than the
//     10 business days CAN-SPAM allows and the 2 days Gmail/Yahoo expect.
//   - a marketing address that cannot be parsed is blocked (fail closed).

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir } from 'node:fs/promises';
import path from 'node:path';

const EVENT_NAME = /^(unsubscribe|resubscribe)-(-?\d+)$/;
const KINDS = new Set(['marketing', 'transactional']);
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

// Reduce an address to one key per person. Aliases of the same mailbox
// (case, +tags, Gmail dots, googlemail.com) must map to the same key so an
// opt-out cannot be dodged by writing the address differently.
// Returns null if the input is not a usable address.
function canonicalAddress(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  const angle = s.match(/<([^<>]*)>/); // "Name" <addr> header form
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, '').normalize('NFKC').toLowerCase();
  if (/\s/.test(s)) return null;

  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return null;
  let local = s.slice(0, at);
  let domain = s.slice(at + 1).replace(/\.$/, '');
  if (GMAIL_DOMAINS.has(domain)) {
    domain = 'gmail.com';
    local = local.replace(/\./g, '');
  }
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (!local || !domain) return null;
  return `${local}@${domain}`;
}

function suppressionDir(key) {
  const root = process.env.STATE_DIR;
  if (!root) throw new Error('STATE_DIR is not set');
  const hash = createHash('sha256').update(key).digest('hex');
  return path.join(root, 'suppression', hash);
}

async function recordEvent(type, email, at) {
  const key = canonicalAddress(email);
  if (!key) throw new TypeError(`not a usable email address: ${String(email)}`);
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new TypeError('at must be a valid Date');
  }

  const dir = suppressionDir(key);
  await mkdir(dir, { recursive: true });
  const finalPath = path.join(dir, `${type}-${at.getTime()}`);

  // 'a' creates the file if missing and does nothing if it already exists.
  const fh = await open(finalPath, 'a');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
  // Make the new directory entry durable too.
  const dirHandle = await open(dir, 'r');
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}

// Returns the list of { type, ms } events for the canonical address.
async function readEvents(key) {
  let names;
  try {
    names = await readdir(suppressionDir(key));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const events = [];
  for (const name of names) {
    const m = EVENT_NAME.exec(name);
    if (m) events.push({ type: m[1], ms: Number(m[2]) });
  }
  return events;
}

// Latest event wins. On an equal timestamp, unsubscribe wins.
function isUnsubscribed(events) {
  let best = null;
  for (const e of events) {
    const rank = e.type === 'unsubscribe' ? 1 : 0;
    if (!best || e.ms > best.ms || (e.ms === best.ms && rank > best.rank)) {
      best = { ms: e.ms, rank, type: e.type };
    }
  }
  return best?.type === 'unsubscribe';
}

export async function recordUnsubscribe(email, at) {
  await recordEvent('unsubscribe', email, at);
}

export async function recordResubscribe(email, at) {
  await recordEvent('resubscribe', email, at);
}

// `now` is accepted for the queue's call signature. None of the rules above
// depend on it: an unsubscribe is honored from the moment it is recorded,
// even when its provider timestamp is ahead of this worker's clock.
export async function mayEmail(message, now) {
  if (!message || typeof message !== 'object') {
    throw new TypeError('message must be an object');
  }
  const key = canonicalAddress(message.to);
  if (!key) return { allowed: false, reason: 'invalid_recipient' };
  if (!KINDS.has(message.kind)) return { allowed: false, reason: 'unknown_kind' };

  if (message.kind === 'transactional') return { allowed: true, reason: null };

  const events = await readEvents(key);
  if (isUnsubscribed(events)) return { allowed: false, reason: 'unsubscribed' };
  return { allowed: true, reason: null };
}
