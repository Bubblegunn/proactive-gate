// Unsubscribe and consent state shared by worker processes through STATE_DIR.
//
// Layout: one append-only file per address at STATE_DIR/suppression/<sha256>.log.
// Each line is a JSON event {at, event, email}. The last event in a file decides
// whether marketing mail is blocked. Order is file order (O_APPEND), not wall-clock
// time, so clock skew between workers cannot reorder an opt-out and an opt-in.
// unsubscribe() and resubscribe() resolve only after fsync, so an acknowledged
// change survives a worker being killed.
import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const KINDS = new Set(['marketing', 'receipt']);
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR environment variable is not set');
  return join(dir, 'suppression');
}

// Case and surrounding spaces are not significant for suppression: a block
// must match any spelling of the same address the form or mail client gave.
function normalize(email) {
  if (typeof email !== 'string') throw new TypeError('email must be a string');
  return email.normalize('NFKC').trim().toLowerCase();
}

function fileFor(addr) {
  const hash = createHash('sha256').update(addr).digest('hex');
  return join(stateDir(), `${hash}.log`);
}

async function append(addr, event) {
  const file = fileFor(addr);
  await mkdir(dirname(file), { recursive: true });
  const record = { at: new Date().toISOString(), event, email: addr };
  const fh = await open(file, 'a');
  try {
    // Leading newline: if an earlier writer was killed mid-line, its torn
    // fragment ends at this newline and does not swallow this record.
    await fh.writeFile(`\n${JSON.stringify(record)}`);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// Returns the last unsubscribe/resubscribe event for an address, or null.
async function lastEvent(addr) {
  let text;
  try {
    text = await readFile(fileFor(addr), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let last = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      // Torn line from a killed writer. That writer never resolved, so the
      // change it was recording was never acknowledged.
      continue;
    }
    if (rec.event === 'unsubscribe' || rec.event === 'resubscribe') last = rec;
  }
  return last;
}

export async function unsubscribe(email) {
  await append(normalize(email), 'unsubscribe');
}

// Only call this after the person deliberately signs up again on the website.
export async function resubscribe(email) {
  await append(normalize(email), 'resubscribe');
}

// `now` is validated but does not change the decision. Suppression is ordered by
// file order, so a worker whose clock lags cannot make a fresh opt-out look
// "in the future" and ignore it.
export async function mayEmail(email, kind, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  const addr = normalize(email);
  if (!KINDS.has(kind)) {
    return { allowed: false, reason: 'Blocked: email kind must be "marketing" or "receipt".' };
  }
  if (!EMAIL_SHAPE.test(addr)) {
    return { allowed: false, reason: 'Blocked: not a valid email address.' };
  }

  const last = await lastEvent(addr);
  const unsubscribed = last?.event === 'unsubscribe';

  if (kind === 'receipt') {
    // Order confirmations, shipping and password-reset mails are transactional,
    // so a marketing unsubscribe does not block them.
    return {
      allowed: true,
      reason: unsubscribed
        ? `Allowed: receipt; the marketing unsubscribe on ${last.at.slice(0, 10)} does not block receipts.`
        : 'Allowed: receipt, and the address has no unsubscribe on record.',
    };
  }

  if (unsubscribed) {
    return {
      allowed: false,
      reason: `Blocked: this address unsubscribed from marketing emails on ${last.at.slice(0, 10)} and has not signed up again since.`,
    };
  }
  return { allowed: true, reason: 'Allowed: marketing email, and the address is not unsubscribed.' };
}
