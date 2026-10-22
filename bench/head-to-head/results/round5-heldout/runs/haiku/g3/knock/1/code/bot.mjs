// Opt-out ledger shared by all worker processes.
//
// State lives in STATE_DIR as immutable event files. Every write creates or
// identically overwrites one file (via temp file + fsync + rename), and every
// decision is a max() over those files. No locks and no in-memory cache are
// needed, so late or out-of-order events and worker restarts cannot lose or
// reorder facts.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';

const KINDS = new Set(['marketing', 'transactional']);

// Maps the spellings of one mailbox to one key: accepts "Name <<EMAIL>>"
// header form, ignores case and surrounding space, drops "+tag" sub-addresses,
// treats googlemail.com as gmail.com, and ignores dots only for Gmail, where
// they do not change the mailbox. Returns null for anything malformed.
function canonicalEmail(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  const angled = s.match(/<([^<>]*)>/);
  if (angled) s = angled[1].trim();
  if (/\s/.test(s)) return null;
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return null;
  let local = s.slice(0, at).toLowerCase();
  let domain = s.slice(at + 1).toLowerCase().replace(/\.$/, '');
  if (local.includes('@') || !domain.includes('.') || domain.includes('@')) return null;
  if (domain === 'googlemail.com') domain = 'gmail.com';
  local = local.split('+')[0];
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  if (!local) return null;
  return `${local}@${domain}`;
}

function stateRoot() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return path.join(dir, 'suppression');
}

function keyDir(key) {
  return path.join(stateRoot(), createHash('sha256').update(key).digest('hex'));
}

async function writeEvent(kind, email, at) {
  const key = canonicalEmail(email);
  if (!key) throw new TypeError(`not an email address: ${String(email)}`);
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new TypeError('at must be a valid Date');
  }
  const dir = keyDir(key);
  await mkdir(dir, { recursive: true });
  const ms = at.getTime();
  // Same kind and same time always yields the same file name and content,
  // so a duplicate delivery just rewrites an identical file.
  const file = path.join(dir, `${kind}-${ms}.json`);
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(tmp, 'wx');
  try {
    await handle.writeFile(JSON.stringify({ kind, key, at: ms, raw: String(email) }));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

// Latest unsubscribe and latest resubscribe seen so far, by provider time.
async function readState(key) {
  const dir = keyDir(key);
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return { unsubAt: null, resubAt: null };
    throw err;
  }
  const state = { unsubAt: null, resubAt: null };
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const ev = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
    if (typeof ev.at !== 'number') throw new Error(`corrupt event file: ${name}`);
    if (ev.kind === 'unsubscribe') {
      state.unsubAt = state.unsubAt === null ? ev.at : Math.max(state.unsubAt, ev.at);
    } else if (ev.kind === 'resubscribe') {
      state.resubAt = state.resubAt === null ? ev.at : Math.max(state.resubAt, ev.at);
    } else {
      throw new Error(`corrupt event kind in ${name}`);
    }
  }
  return state;
}

// Suppressed when there is an unsubscribe and no resubscribe strictly after it.
// A tie counts as unsubscribed, since an opt-out must not be lost to a race.
function isSuppressed({ unsubAt, resubAt }) {
  return unsubAt !== null && (resubAt === null || resubAt <= unsubAt);
}

export async function recordUnsubscribe(email, at) {
  await writeEvent('unsubscribe', email, at);
}

export async function recordResubscribe(email, at) {
  await writeEvent('resubscribe', email, at);
}

export async function mayEmail(message, now) {
  if (!message || typeof message !== 'object') throw new TypeError('message must be an object');
  if (!KINDS.has(message.kind)) throw new TypeError(`unknown kind: ${String(message.kind)}`);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  const key = canonicalEmail(message.to);
  if (!key) return { allowed: false, reason: 'invalid_recipient' };

  // CAN-SPAM 15 U.S.C. 7704 covers commercial messages only. Order receipts and
  // password resets are transactional and are still allowed after an opt-out.
  if (message.kind === 'transactional') return { allowed: true, reason: null };

  // Fail closed: if the ledger cannot be read, marketing is not sent.
  let state;
  try {
    state = await readState(key);
  } catch {
    return { allowed: false, reason: 'suppression_state_unavailable' };
  }
  if (isSuppressed(state)) return { allowed: false, reason: 'unsubscribed' };
  return { allowed: true, reason: null };
}
