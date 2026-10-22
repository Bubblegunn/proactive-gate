// Email suppression for newsletters and receipts.
//
// State lives only in STATE_DIR so that any worker on the machine sees the
// same decisions. Each address gets its own append-only JSON-lines file under
// STATE_DIR/suppression/. Appends use O_APPEND and are fsynced before the
// caller resolves, so records written by one worker are visible to the others
// and survive a kill. The last event in file order decides the state.

import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const KINDS = new Set(['marketing', 'receipt']);

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR environment variable is not set');
  return dir;
}

// Case and surrounding spaces do not make a different address.
function normalize(email) {
  if (typeof email !== 'string') throw new TypeError('email must be a string');
  const e = email.normalize('NFKC').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    throw new TypeError(`not a valid email address: ${JSON.stringify(email)}`);
  }
  return e;
}

function fileFor(normalized) {
  const hash = createHash('sha256').update(normalized).digest('hex');
  return join(stateDir(), 'suppression', `${hash}.jsonl`);
}

async function append(event, normalized) {
  await mkdir(join(stateDir(), 'suppression'), { recursive: true });
  // The leading newline ends any line a killed worker left half-written, so
  // the new record always starts on its own line.
  const line = '\n' + JSON.stringify({ event, email: normalized, at: new Date().toISOString() });
  const handle = await open(fileFor(normalized), 'a');
  try {
    await handle.write(line);
    await handle.datasync();
  } finally {
    await handle.close();
  }
}

// Returns the valid events in file order. `corrupt` is true when any line
// could not be parsed. The caller must then fail closed for marketing.
async function readEvents(normalized) {
  let text;
  try {
    text = await readFile(fileFor(normalized), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { events: [], corrupt: false };
    throw err;
  }
  const events = [];
  let corrupt = false;
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    try {
      const ev = JSON.parse(raw);
      if (ev.event === 'unsubscribe' || ev.event === 'resubscribe') {
        events.push(ev);
      } else {
        corrupt = true;
      }
    } catch {
      corrupt = true;
    }
  }
  return { events, corrupt };
}

// Called when the person unsubscribes by link, reply, or one-click request.
// Blocks marketing mail until a deliberate resubscribe. Receipts are not affected.
export async function unsubscribe(email) {
  await append('unsubscribe', normalize(email));
}

// Called only when the person deliberately signs up again on the website.
export async function resubscribe(email) {
  await append('resubscribe', normalize(email));
}

// Called by a worker just before it hands an email to the mail provider.
// Throws on bad arguments so that a bad call never results in a send.
// `now` is validated but does not change the decision: unsubscribes take
// effect as soon as they are recorded, not after a delay.
export async function mayEmail(email, kind, now) {
  const normalized = normalize(email);
  if (!KINDS.has(kind)) throw new TypeError(`unknown kind: ${JSON.stringify(kind)}`);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }

  if (kind === 'receipt') {
    return {
      allowed: true,
      reason: 'Allowed: receipts are transactional and are not blocked by a marketing unsubscribe.',
    };
  }

  const { events, corrupt } = await readEvents(normalized);
  if (corrupt) {
    return {
      allowed: false,
      reason: 'Blocked: the suppression record for this address is unreadable, so marketing email is held until support checks it.',
    };
  }
  const last = events.at(-1);
  if (last && last.event === 'unsubscribe') {
    return {
      allowed: false,
      reason: `Blocked: this address unsubscribed from marketing email on ${last.at}; it stays blocked until the person signs up again on the website.`,
    };
  }
  return {
    allowed: true,
    reason: 'Allowed: no unsubscribe is on record for this address.',
  };
}
