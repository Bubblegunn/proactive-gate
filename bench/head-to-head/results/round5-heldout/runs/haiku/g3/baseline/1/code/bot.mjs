// Suppression ledger for outgoing email, shared by all workers through STATE_DIR.
//
// Storage: one append-only JSONL file per person under STATE_DIR/suppression/.
// Each worker only appends (O_APPEND + fsync), so no locks are needed and a
// worker that restarts sees every event already written. Readers ignore
// unparseable lines (a torn write from a crash).
//
// Rules:
// - Unsubscribe stops marketing email to that person. Transactional email
//   (order receipts, password resets) is still allowed.
// - The latest event by provider time decides the state, so late or
//   out-of-order events are handled. On an exact timestamp tie, the
//   unsubscribe wins.
// - A person is identified by a canonical address: case, header wrapping,
//   "+tag" suffixes and, for Gmail, dots and googlemail.com are ignored.
//   Two addresses that reach the same mailbox share one opt-out.
// - `now` is validated but does not change the decision. Provider clocks
//   can run ahead of ours, so an unsubscribe stamped just after `now` must
//   still count.

import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

function suppressionDir() {
  const root = process.env.STATE_DIR;
  if (!root) throw new Error('STATE_DIR is not set');
  return path.join(root, 'suppression');
}

// "Name <Addr@Example.COM>" or "mailto:<EMAIL>" -> "addr@example.com" (raw, lowercased).
function addressOf(raw) {
  let s = String(raw ?? '').normalize('NFKC').trim();
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, '');
  return s.toLowerCase();
}

// Returns the canonical mailbox key, or null when the text is not an address.
function canonicalAddress(raw) {
  const addr = addressOf(raw);
  const at = addr.lastIndexOf('@');
  if (at < 1 || at === addr.length - 1) return null;

  let local = addr.slice(0, at);
  let domain = addr.slice(at + 1).replace(/\.$/, '');
  if (GMAIL_DOMAINS.has(domain)) domain = 'gmail.com';

  // Drop "+tag", but keep the local part if the tag was the whole thing.
  const base = local.split('+')[0];
  if (base) local = base;
  if (domain === 'gmail.com') local = local.replace(/\./g, '');

  if (!local || !domain.includes('.')) return null;
  return `${local}@${domain}`;
}

function ledgerPath(key) {
  const hash = createHash('sha256').update(key).digest('hex');
  return path.join(suppressionDir(), `${hash}.jsonl`);
}

async function appendEvent(key, record) {
  await mkdir(suppressionDir(), { recursive: true });
  const handle = await open(ledgerPath(key), 'a');
  try {
    // Leading newline: if an earlier writer crashed mid-line, this record
    // still starts on its own line instead of being glued to the torn one.
    await handle.appendFile(`\n${JSON.stringify(record)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readEvents(key) {
  let text;
  try {
    text = await readFile(ledgerPath(key), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Torn write from a crashed worker. The event was never acknowledged, so skip it.
    }
  }
  return events;
}

// Latest event by time wins. On an exact tie, unsubscribe wins (fail closed).
function isOptedOut(events) {
  let latest = null;
  for (const event of events) {
    const time = Date.parse(event.at);
    if (Number.isNaN(time)) continue;
    const rank = event.type === 'unsubscribe' ? 1 : 0;
    if (!latest || time > latest.time || (time === latest.time && rank > latest.rank)) {
      latest = { time, rank, type: event.type };
    }
  }
  return latest?.type === 'unsubscribe';
}

async function recordEvent(type, email, at) {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new TypeError('at must be a valid Date');
  }
  // An address that does not canonicalize cannot match any valid recipient,
  // but it is still kept for the audit trail.
  const key = canonicalAddress(email) ?? addressOf(email);
  await appendEvent(key, {
    type,
    at: at.toISOString(),
    address: addressOf(email),
    recordedAt: new Date().toISOString(),
  });
}

export async function recordUnsubscribe(email, at) {
  await recordEvent('unsubscribe', email, at);
}

export async function recordResubscribe(email, at) {
  await recordEvent('resubscribe', email, at);
}

export async function mayEmail(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }

  const key = canonicalAddress(message?.to);
  if (!key) return { allowed: false, reason: 'invalid_recipient' };

  if (message.kind === 'transactional') return { allowed: true, reason: null };
  if (message.kind !== 'marketing') return { allowed: false, reason: 'unknown_kind' };

  let events;
  try {
    events = await readEvents(key);
  } catch {
    // Cannot read the ledger, so we cannot prove the person is still subscribed. Fail closed.
    return { allowed: false, reason: 'suppression_state_unavailable' };
  }
  if (isOptedOut(events)) return { allowed: false, reason: 'unsubscribed' };

  return { allowed: true, reason: null };
}
