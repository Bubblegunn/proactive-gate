// Unsubscribe state and send gate for newsletter (marketing) and receipt mail.
//
// All state lives in STATE_DIR, the only directory workers share. Each address
// gets its own folder of immutable event files. A writer creates a temp file,
// fsyncs it, and renames it into place, so no two workers ever write the same
// file and a killed worker leaves at most a temp file that readers ignore.
//
// Event file names sort in event order: zero-padded time in ms, then an op
// rank (on the same ms, unsubscribe sorts after resubscribe, so it wins), then
// a random id. The newest file is the current state.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const KINDS = new Set(['marketing', 'receipt']);
const OP_RANK = { resubscribe: 0, unsubscribe: 1 };

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

// Returns the matching key for an address, or null if it is not a usable address.
// Trims, lower-cases, and drops a "+tag" from the local part, so <EMAIL>
// and <EMAIL> share one record. For an opt-out, matching too much is the safe error.
function canonical(email) {
  if (typeof email !== 'string') return null;
  const s = email.normalize('NFC').trim().toLowerCase();
  if (/\s/.test(s)) return null;
  const at = s.lastIndexOf('@');
  if (at < 0) return null;
  const local = s.slice(0, at).replace(/\+.*$/, '');
  const domain = s.slice(at + 1);
  if (!local || !domain || domain.includes('@') || !domain.includes('.')) return null;
  return `${local}@${domain}`;
}

function addressDir(key) {
  const hash = createHash('sha256').update(key).digest('hex');
  return join(stateDir(), 'subscriptions', hash);
}

async function appendEvent(op, email) {
  const key = canonical(email);
  if (!key) throw new TypeError('email is not a valid address');

  const dir = addressDir(key);
  await mkdir(dir, { recursive: true });

  const at = Date.now();
  const name = `${String(at).padStart(15, '0')}-${OP_RANK[op]}-${randomUUID()}.json`;
  const body = JSON.stringify({ op, at: new Date(at).toISOString() }) + '\n';

  const tmp = join(dir, `.tmp-${randomUUID()}`);
  const file = await open(tmp, 'wx');
  try {
    await file.writeFile(body);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(tmp, join(dir, name));

  // Make the rename itself durable, so a power cut cannot drop the event.
  const dirHandle = await open(dir, 'r');
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }

  return at;
}

// Returns the newest event for an address, or null if there is none.
// Throws if the state cannot be read, so callers can fail closed.
async function currentEvent(key) {
  const dir = addressDir(key);
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const events = names.filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
  if (events.length === 0) return null;

  const event = JSON.parse(await readFile(join(dir, events.at(-1)), 'utf8'));
  if (event.op !== 'unsubscribe' && event.op !== 'resubscribe') {
    throw new Error(`unknown event op in ${events.at(-1)}`);
  }
  return event;
}

// Records that the person opted out. Applies to every kind of mail.
// Resolves once the record is on disk.
export async function unsubscribe(email) {
  await appendEvent('unsubscribe', email);
  return { status: 'unsubscribed' };
}

// Records that the person deliberately signed up again on the website.
// Clears an earlier unsubscribe, for marketing mail.
export async function resubscribe(email) {
  await appendEvent('resubscribe', email);
  return { status: 'subscribed' };
}

// Decides whether a worker may send one email of this kind to this address.
// Marketing mail is blocked after an unsubscribe. Receipts are transactional
// and are not blocked by an unsubscribe. An invalid address and an unreadable
// state both block marketing mail, so a failure never leads to a send.
export async function mayEmail(email, kind, now) {
  if (!KINDS.has(kind)) {
    throw new TypeError(`kind must be "marketing" or "receipt", got ${JSON.stringify(kind)}`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }

  const key = canonical(email);
  if (!key) {
    return { allowed: false, reason: 'Not sent: the address is missing or is not a valid email address.' };
  }

  if (kind === 'receipt') {
    return { allowed: true, reason: 'Allowed: receipts are transactional, so newsletter unsubscribes do not block them.' };
  }

  let event;
  try {
    event = await currentEvent(key);
  } catch (err) {
    return { allowed: false, reason: `Not sent: the unsubscribe list could not be read (${err.message}), so marketing mail is held.` };
  }

  if (event && event.op === 'unsubscribe') {
    return {
      allowed: false,
      reason: `Not sent: this address unsubscribed from marketing mail on ${event.at} and has not signed up again since.`,
    };
  }
  return { allowed: true, reason: 'Allowed: no unsubscribe is on record for this address.' };
}
