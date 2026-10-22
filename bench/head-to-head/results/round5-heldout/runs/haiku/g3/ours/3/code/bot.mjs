// Email suppression gate for an agent that sends marketing and transactional mail.
//
// State lives in STATE_DIR and is shared by every worker process. Each unsubscribe or
// resubscribe event is one file, created with an atomic link() so that:
//   - two workers never overwrite each other (no read-modify-write, no lock),
//   - a redelivered webhook event is stored once (the file name is a hash of the event),
//   - no reader ever sees a half-written file.
// The current status of an address is the event with the latest provider time `at`.
// On an exact tie, unsubscribe wins. A late resubscribe therefore cannot undo a newer
// unsubscribe, and a late unsubscribe cannot undo a newer resubscribe.

import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const UNSUBSCRIBE = 'unsubscribe';
const RESUBSCRIBE = 'resubscribe';

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

// One address can appear as "Name <<EMAIL>>". All of these name one person.
export function normalizeEmail(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  const angle = s.match(/<([^<>]+)>$/);
  if (angle) s = angle[1].trim();
  s = s.toLowerCase();
  const m = s.match(/^([^@\s]+)@([^@\s]+)$/);
  if (!m) return null;
  let [, local, domain] = m;
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  local = local.replace(/\+.*$/, '');
  if (!local || !domain.includes('.') || domain.includes('..')) return null;
  return `${local}@${domain}`;
}

function validDate(d) {
  return d instanceof Date && Number.isFinite(d.getTime());
}

function eventDir(key) {
  const id = createHash('sha256').update(key).digest('hex').slice(0, 40);
  return join(stateDir(), 'suppression', id);
}

async function writeEvent(key, type, at) {
  const dir = eventDir(key);
  await mkdir(dir, { recursive: true });
  const atMs = at.getTime();
  const body = JSON.stringify({ type, at: atMs });
  const name = createHash('sha256').update(`${type}|${key}|${atMs}`).digest('hex') + '.json';
  // Write a complete temp file first, then publish it with link(). link() fails with
  // EEXIST when the same event is already stored, so a redelivery does nothing.
  const tmp = join(dir, `tmp-${randomUUID()}`);
  await writeFile(tmp, body);
  try {
    await link(tmp, join(dir, name));
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

async function currentStatus(key) {
  const dir = eventDir(key);
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let best = null;
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const ev = JSON.parse(await readFile(join(dir, n), 'utf8'));
    const better =
      !best ||
      ev.at > best.at ||
      (ev.at === best.at && ev.type === UNSUBSCRIBE && best.type !== UNSUBSCRIBE);
    if (better) best = ev;
  }
  return best;
}

export async function recordUnsubscribe(email, at) {
  const key = normalizeEmail(email);
  if (!key) throw new TypeError('recordUnsubscribe: invalid email address');
  if (!validDate(at)) throw new TypeError('recordUnsubscribe: at must be a valid Date');
  await writeEvent(key, UNSUBSCRIBE, at);
}

export async function recordResubscribe(email, at) {
  const key = normalizeEmail(email);
  if (!key) throw new TypeError('recordResubscribe: invalid email address');
  if (!validDate(at)) throw new TypeError('recordResubscribe: at must be a valid Date');
  await writeEvent(key, RESUBSCRIBE, at);
}

export async function mayEmail(message, now) {
  const allowed = { allowed: true, reason: null };
  const key = normalizeEmail(message?.to);
  if (!key) return { allowed: false, reason: 'invalid_address' };
  if (message.kind === 'transactional') return allowed; // receipts, password resets
  if (message.kind !== 'marketing') return { allowed: false, reason: 'unknown_kind' };

  // Marketing: an unsubscribe that is the latest event for this person stops it at once.
  // Any later explicit resubscribe re-enables it.
  const status = await currentStatus(key);
  if (status && status.type === UNSUBSCRIBE) return { allowed: false, reason: 'unsubscribed' };
  return allowed;
}
