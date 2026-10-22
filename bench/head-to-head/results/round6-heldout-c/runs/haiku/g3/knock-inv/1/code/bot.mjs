// Email consent state shared by all worker processes on one machine.
//
// Storage: STATE_DIR/consent/<sha256 of normalised address>/<event file>.json
// Every event is its own file, written to a temp name, fsynced, then renamed
// into place. Renames are atomic and every file name is unique, so workers never
// overwrite each other, a killed worker leaves no half-written event behind, and
// a restarted worker reads the same history from disk.
//
// Rules:
// - unsubscribe(email) stops all marketing email to that address, effective at once.
//   Receipts (order confirmations, shipping, password reset) are still allowed.
// - resubscribe(email) is a deliberate website signup. It is the only way to get
//   marketing consent. An address with no signup on record gets no marketing email.
//   This opt-in model satisfies the EU rule (prior consent for marketing), and it is
//   stricter than the US opt-out rule, so one rule covers both markets.
// - The latest event decides the state.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';

const KINDS = new Set(['marketing', 'receipt']);
const UNSUBSCRIBE = 'unsubscribe';
const SUBSCRIBE = 'subscribe';

function consentRoot() {
  const dir = process.env.STATE_DIR;
  if (!dir) {
    throw new Error('STATE_DIR is not set');
  }
  return path.join(dir, 'consent');
}

// Trim, lowercase and NFC-normalise the address. Returns null when the value is not an address.
function normaliseEmail(email) {
  if (typeof email !== 'string') {
    return null;
  }
  const value = email.normalize('NFC').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return null;
  }
  return value;
}

function eventDir(email) {
  const hash = createHash('sha256').update(email).digest('hex');
  return path.join(consentRoot(), hash);
}

async function recordEvent(email, event) {
  const dir = eventDir(email);
  await mkdir(dir, { recursive: true });

  const ts = Date.now();
  // Zero-padded time first, so a plain string sort is time order.
  // On the same millisecond, unsubscribe (rank 1) sorts after subscribe (rank 0),
  // so a tie resolves to "unsubscribed".
  const rank = event === UNSUBSCRIBE ? 1 : 0;
  const id = randomBytes(8).toString('hex');
  const name = `${String(ts).padStart(15, '0')}-${rank}-${id}.json`;
  const tmp = path.join(dir, `.tmp-${id}`);
  const body = `${JSON.stringify({ email, event, ts, at: new Date(ts).toISOString() })}\n`;

  const handle = await open(tmp, 'wx');
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path.join(dir, name));
}

async function latestEvent(email) {
  const dir = eventDir(email);
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }

  const files = names.filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort();
  if (files.length === 0) {
    return null;
  }
  const text = await readFile(path.join(dir, files[files.length - 1]), 'utf8');
  return JSON.parse(text);
}

export async function unsubscribe(email) {
  const normalised = normaliseEmail(email);
  if (!normalised) {
    throw new TypeError('unsubscribe: not a valid email address');
  }
  await recordEvent(normalised, UNSUBSCRIBE);
}

export async function resubscribe(email) {
  const normalised = normaliseEmail(email);
  if (!normalised) {
    throw new TypeError('resubscribe: not a valid email address');
  }
  await recordEvent(normalised, SUBSCRIBE);
}

export async function mayEmail(email, kind, now) {
  if (!KINDS.has(kind)) {
    return { allowed: false, reason: `Unknown email kind "${kind}"; use "marketing" or "receipt".` };
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return { allowed: false, reason: 'No valid send time was given, so the email was not sent.' };
  }

  const normalised = normaliseEmail(email);
  if (!normalised) {
    return { allowed: false, reason: 'The address is not a valid email address, so nothing can be sent to it.' };
  }

  if (kind === 'receipt') {
    return {
      allowed: true,
      reason: 'Receipt or transactional email: allowed, because it is needed even when marketing is switched off.',
    };
  }

  // The state is read from disk on every call, so a restarted worker sees all earlier events.
  const last = await latestEvent(normalised);
  if (last && last.event === UNSUBSCRIBE) {
    return {
      allowed: false,
      reason: `This address unsubscribed from marketing emails at ${last.at}, so no newsletters or offers are sent unless they sign up again.`,
    };
  }
  if (!last || last.event !== SUBSCRIBE) {
    return {
      allowed: false,
      reason: 'No marketing opt-in is on record for this address; newsletters and offers only go to people who signed up on the website.',
    };
  }
  return {
    allowed: true,
    reason: `Marketing opt-in on record since ${last.at} and no unsubscribe since then; allowed.`,
  };
}
