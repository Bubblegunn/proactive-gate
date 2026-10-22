// Consent and suppression state for marketing and receipt email.
//
// Storage: STATE_DIR/consent/<sha256 of address>.jsonl, one file per address.
// Every change is one appended JSON line, so workers never rewrite a shared file.
// The newest line in a file is the current state.
//
// Rules:
// - marketing: allowed only after a deliberate sign-up (resubscribe) that is
//   newer than any unsubscribe. No record means no marketing mail.
// - receipt: allowed. Order, shipping and password-reset mail is transactional
//   and is not stopped by a marketing unsubscribe.

import { createHash } from 'node:crypto';
import { promises as fs, constants as fsc } from 'node:fs';
import path from 'node:path';

const KINDS = new Set(['marketing', 'receipt']);
const UNSUBSCRIBED = 'unsubscribed';
const SUBSCRIBED = 'subscribed';

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return path.resolve(dir);
}

// Lowercase and trim. Local-part case is treated as insignificant, which is
// the common practice for shop mail. Dot or plus aliases are not merged.
function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function isValidEmail(addr) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr);
}

function requireAddress(email) {
  const addr = normalizeEmail(email);
  if (!isValidEmail(addr)) throw new TypeError(`Not a valid email address: ${JSON.stringify(email)}`);
  return addr;
}

function fileFor(addr) {
  const digest = createHash('sha256').update(addr).digest('hex');
  return path.join(stateDir(), 'consent', `${digest}.jsonl`);
}

async function readEvents(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      if (event && (event.type === UNSUBSCRIBED || event.type === SUBSCRIBED)) events.push(event);
    } catch {
      // A line torn by a worker that crashed mid-write. Skip it.
    }
  }
  return events;
}

// The newest valid event decides. Returns undefined when there is no record.
function currentState(events) {
  return events.at(-1)?.type;
}

async function appendEvent(addr, type) {
  const file = fileFor(addr);
  await fs.mkdir(path.dirname(file), { recursive: true });
  // The leading newline ends any torn line left by a crash, so the new record
  // is never glued onto it.
  const line = '\n' + JSON.stringify({ type, email: addr, at: new Date().toISOString() }) + '\n';
  const fh = await fs.open(file, fsc.O_WRONLY | fsc.O_APPEND | fsc.O_CREAT);
  try {
    const isNew = (await fh.stat()).size === 0;
    await fh.appendFile(line);
    await fh.sync();
    if (isNew) {
      // Make the new directory entry durable too.
      const dh = await fs.open(path.dirname(file), 'r');
      try {
        await dh.sync();
      } finally {
        await dh.close();
      }
    }
  } finally {
    await fh.close();
  }
}

// Called when the person clicks an unsubscribe link, replies asking to stop,
// or a mailbox provider sends a one-click unsubscribe. Idempotent.
export async function unsubscribe(email) {
  const addr = requireAddress(email);
  if (currentState(await readEvents(fileFor(addr))) === UNSUBSCRIBED) return;
  await appendEvent(addr, UNSUBSCRIBED);
}

// Called only when the person deliberately signs up again on the website.
// This is the marketing opt-in. Idempotent.
export async function resubscribe(email) {
  const addr = requireAddress(email);
  if (currentState(await readEvents(fileFor(addr))) === SUBSCRIBED) return;
  await appendEvent(addr, SUBSCRIBED);
}

// Called by a worker just before it hands an email to the mail provider.
// Resolves to { allowed, reason }. The reason is a short sentence for support staff.
export async function mayEmail(email, kind, now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  if (!KINDS.has(kind)) {
    return { allowed: false, reason: `Unknown email kind "${kind}". Only "marketing" and "receipt" are allowed.` };
  }
  const addr = normalizeEmail(email);
  if (!isValidEmail(addr)) {
    return { allowed: false, reason: 'The address is not a valid email address, so nothing was sent.' };
  }
  if (kind === 'receipt') {
    return { allowed: true, reason: 'Receipt or account mail. Marketing opt-outs do not apply to it.' };
  }
  const state = currentState(await readEvents(fileFor(addr)));
  if (state === SUBSCRIBED) {
    return { allowed: true, reason: 'The person opted in to marketing email and has not unsubscribed since.' };
  }
  if (state === UNSUBSCRIBED) {
    return { allowed: false, reason: 'The person unsubscribed from marketing email and has not signed up again.' };
  }
  return { allowed: false, reason: 'No marketing opt-in is on record for this address, so marketing email is blocked.' };
}
