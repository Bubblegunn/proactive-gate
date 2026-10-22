// Opt-out gate for the shop's outgoing email.
// State: STATE_DIR/optout/<sha256(normalized address)>/<ms>-<rand>.json, one file per provider event.
// Files are written to a temp name and renamed, so workers never read a partial file and never overwrite each other.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Turns "Name <Mail@Example.com>", "mailto:x@y.z" or " X@Y.Z " into one key per person.
// Gmail ignores dots and "+tag" parts, and googlemail.com is Gmail, so those collapse too.
// Other providers: "+tag" is stripped (an alias of the same mailbox). Returns null if not an address.
export function normalizeAddress(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  const header = s.match(/<([^<>]+)>\s*$/);
  if (header) s = header[1].trim();
  s = s.replace(/^mailto:/i, '').normalize('NFKC').toLowerCase();
  const at = s.lastIndexOf('@');
  if (at <= 0) return null;
  let local = s.slice(0, at);
  let domain = s.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  local = local.replace(/\+.*$/, '');
  const address = `${local}@${domain}`;
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address) ? address : null;
}

// STATE_DIR is read on every call so a worker always sees the current value.
function optoutDir(address) {
  const root = process.env.STATE_DIR;
  if (!root) throw new Error('STATE_DIR is not set');
  const key = createHash('sha256').update(address).digest('hex');
  return join(root, 'optout', key);
}

function assertDate(at) {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new TypeError('at must be a valid Date');
  }
}

async function appendEvent(address, type, at) {
  const dir = optoutDir(address);
  await mkdir(dir, { recursive: true });
  const rand = randomBytes(8).toString('hex');
  const tmp = join(dir, `.tmp-${rand}`);
  const final = join(dir, `${at.getTime()}-${rand}.json`);
  await writeFile(tmp, JSON.stringify({ type, at: at.getTime() }));
  await rename(tmp, final);
}

// Latest unsubscribe and latest resubscribe, by the provider's `at` (not by arrival order).
async function latestEvents(address) {
  const dir = optoutDir(address);
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return { unsub: null, resub: null };
    throw err;
  }
  let unsub = null;
  let resub = null;
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const ev = JSON.parse(await readFile(join(dir, name), 'utf8'));
    if (ev.type === 'unsubscribe' && (unsub === null || ev.at > unsub)) unsub = ev.at;
    if (ev.type === 'resubscribe' && (resub === null || ev.at > resub)) resub = ev.at;
  }
  return { unsub, resub };
}

export async function recordUnsubscribe(email, at) {
  const address = normalizeAddress(email);
  if (address === null) throw new TypeError('email is not an address');
  assertDate(at);
  await appendEvent(address, 'unsubscribe', at);
}

export async function recordResubscribe(email, at) {
  const address = normalizeAddress(email);
  if (address === null) throw new TypeError('email is not an address');
  assertDate(at);
  await appendEvent(address, 'resubscribe', at);
}

// Transactional mail (receipts, password resets) is not stopped by an unsubscribe.
// Marketing is stopped by an unsubscribe unless a later resubscribe exists.
// A tie in `at` favors the unsubscribe. Any kind other than "transactional" is treated as marketing.
export async function mayEmail(message, now) {
  if (!message || typeof message !== 'object') throw new TypeError('message must be an object');
  if (message.kind === 'transactional') return { allowed: true, reason: null };

  const address = normalizeAddress(message.to);
  if (address === null) return { allowed: false, reason: 'invalid_recipient' };

  const { unsub, resub } = await latestEvents(address);
  const unsubscribed = unsub !== null && (resub === null || unsub >= resub);
  if (unsubscribed) return { allowed: false, reason: 'unsubscribed' };

  return { allowed: true, reason: null };
}
