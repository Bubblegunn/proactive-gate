import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const KINDS = new Set(['marketing', 'receipt']);

// STATE_DIR is read on every call, so a restarted worker sees the same records.
function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function normalizeEmail(email) {
  if (typeof email !== 'string') throw new TypeError('email must be a string');
  const e = email.trim().toLowerCase();
  const parts = e.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1] || /\s/.test(e)) {
    throw new TypeError('not a valid email address');
  }
  return e;
}

// One directory per address (hashed, so the name is safe on disk).
function emailDir(email) {
  const hash = createHash('sha256').update(email).digest('hex');
  return join(stateDir(), 'optout', hash);
}

// Each event gets its own file name, so two workers never write the same path.
// Write a temp file, then rename it: a reader sees the whole record or none of it.
async function writeEvent(email, type) {
  const dir = emailDir(email);
  await mkdir(dir, { recursive: true });
  const at = Date.now();
  const name = `${at}-${randomBytes(8).toString('hex')}`;
  const tmp = join(dir, `.${name}.tmp`);
  await writeFile(tmp, JSON.stringify({ type, email, at }));
  await rename(tmp, join(dir, `${name}.json`));
}

async function readEvents(email) {
  const dir = emailDir(email);
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const events = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue; // temp file still being written
    const ev = JSON.parse(await readFile(join(dir, name), 'utf8'));
    if ((ev.type !== 'unsubscribe' && ev.type !== 'resubscribe') || !Number.isFinite(ev.at)) {
      throw new Error(`bad opt-out record ${name}`);
    }
    events.push(ev);
  }
  return events;
}

// Opted out when the latest unsubscribe is not followed by a later resubscribe.
// On a tie in the same millisecond the opt-out wins, the safer side.
async function optOutState(email) {
  let lastUnsub = null;
  let lastResub = null;
  for (const ev of await readEvents(email)) {
    if (ev.type === 'unsubscribe') {
      if (!lastUnsub || ev.at > lastUnsub.at) lastUnsub = ev;
    } else if (!lastResub || ev.at > lastResub.at) {
      lastResub = ev;
    }
  }
  const optedOut = lastUnsub !== null && (lastResub === null || lastResub.at <= lastUnsub.at);
  return { optedOut, at: lastUnsub ? lastUnsub.at : null };
}

export async function unsubscribe(email) {
  await writeEvent(normalizeEmail(email), 'unsubscribe');
}

export async function resubscribe(email) {
  await writeEvent(normalizeEmail(email), 'resubscribe');
}

export async function mayEmail(email, kind, now) {
  const refuse = (reason) => ({ allowed: false, reason });
  if (!KINDS.has(kind)) {
    return refuse(`Not sent: unknown mail kind "${kind}"; use "marketing" or "receipt".`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return refuse('Not sent: the send time is not a valid date.');
  }
  let e;
  try {
    e = normalizeEmail(email);
  } catch {
    return refuse('Not sent: the address is not a valid email address.');
  }
  // Receipts are transactional, not marketing, so an unsubscribe does not stop them.
  if (kind === 'receipt') {
    return {
      allowed: true,
      reason: 'Allowed: receipts (order confirmations, shipping, password reset) are not marketing, so an unsubscribe does not stop them.',
    };
  }
  let state;
  try {
    state = await optOutState(e);
  } catch {
    return refuse('Not sent: the opt-out record could not be read, so the send is held until it can be checked.');
  }
  if (state.optedOut) {
    const day = new Date(state.at).toISOString().slice(0, 10);
    return refuse(`Not sent: this address unsubscribed from marketing email on ${day}. It stays off until the person signs up again on the website.`);
  }
  return { allowed: true, reason: 'Allowed: marketing email and no unsubscribe is on record for this address.' };
}
