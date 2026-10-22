// Suppression list and send gate for newsletter (marketing) and receipt mail.
//
// State lives only in STATE_DIR. Every worker appends to the same files, and a
// newly started worker reads them back, so nothing is kept in memory across calls.
//
// Layout: STATE_DIR/addresses/<sha256 of address key>.log
// Each line is one JSON event: {"op":"unsubscribe"|"resubscribe","key":...,"at":ISO}.
// The last event in a file decides the state for that address. The file is
// opened with O_APPEND, so events from concurrent workers are kept in the order
// they were written, even when several land in the same second.
//
// Rules this module enforces:
//  - An unsubscribe stops marketing mail to that address at once, for every
//    marketing kind of mail, until the person signs up again on the website.
//  - Only resubscribe() lifts that stop. Nothing else (a new order, a receipt,
//    a password reset) re-enables marketing.
//  - Receipts (order confirmations, shipping, password reset) are not blocked
//    by an unsubscribe. They are transactional mail, not marketing.
//  - If the suppression state cannot be read, nothing is sent (fail closed).

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const KINDS = new Set(['marketing', 'receipt']);

function addressesDir() {
  const stateDir = process.env.STATE_DIR;
  if (!stateDir) throw new Error('STATE_DIR environment variable is not set');
  return join(stateDir, 'addresses');
}

// Maps one address to the key used for suppression. Case and surrounding
// whitespace are ignored. For Gmail, dots and +tags are ignored too, because
// they reach the same mailbox. This only widens suppression, which is the safe
// direction.
export function addressKey(email) {
  if (typeof email !== 'string') throw new TypeError('email must be a string');
  const s = email.trim().toLowerCase();
  const parts = s.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1] || /\s/.test(s)) {
    throw new TypeError(`not a valid email address: ${JSON.stringify(email)}`);
  }
  let [local, domain] = parts;
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') {
    const stripped = local.split('+')[0].replace(/\./g, '');
    if (stripped) local = stripped;
  }
  return `${local}@${domain}`;
}

function logPath(dir, key) {
  const digest = createHash('sha256').update(key).digest('hex');
  return join(dir, `${digest}.log`);
}

async function appendEvent(op, email) {
  const key = addressKey(email);
  const dir = addressesDir();
  await mkdir(dir, { recursive: true });
  const handle = await open(logPath(dir, key), 'a');
  try {
    // The leading newline ends any partial line a killed worker left behind,
    // so that partial line cannot swallow this event.
    await handle.appendFile(`\n${JSON.stringify({ op, key, at: new Date().toISOString() })}\n`);
    // Only return once the event is on disk, so a worker that is killed after
    // this point cannot lose it.
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Returns the events for one address in write order. Lines that do not parse
// are partial writes from a killed worker. Such a write was never acknowledged,
// so skipping it is correct.
async function readEvents(key) {
  const dir = addressesDir();
  let text;
  try {
    text = await readFile(logPath(dir, key), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event && (event.op === 'unsubscribe' || event.op === 'resubscribe')) events.push(event);
    } catch {
      // Partial write, see above.
    }
  }
  return events;
}

export async function unsubscribe(email) {
  await appendEvent('unsubscribe', email);
}

// Always appends, even when the address is not suppressed. Checking first and
// then appending would race with a concurrent unsubscribe from another worker.
export async function resubscribe(email) {
  await appendEvent('resubscribe', email);
}

// `now` must be a valid Date. It is checked, but the decision does not depend
// on it: an unsubscribe on record applies to every later send.
export async function mayEmail(email, kind, now) {
  if (!KINDS.has(kind)) {
    throw new TypeError(`kind must be "marketing" or "receipt", got ${JSON.stringify(kind)}`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  addressesDir(); // Fails loudly on a missing STATE_DIR instead of blocking quietly.

  let key;
  try {
    key = addressKey(email);
  } catch {
    return { allowed: false, reason: 'Not sent: the address is not a valid email address.' };
  }

  let last;
  try {
    const events = await readEvents(key);
    last = events[events.length - 1];
  } catch {
    return {
      allowed: false,
      reason: 'Not sent: the unsubscribe list could not be read, so the send was blocked to be safe.',
    };
  }

  if (!last || last.op !== 'unsubscribe') {
    return { allowed: true, reason: 'No unsubscribe on record for this address.' };
  }
  if (kind === 'receipt') {
    return {
      allowed: true,
      reason: 'Allowed: this address unsubscribed from marketing, but receipts are transactional mail and are not blocked.',
    };
  }
  return {
    allowed: false,
    reason: `Not sent: this address unsubscribed from marketing emails on ${last.at} and stays blocked until the person signs up again on the website.`,
  };
}
