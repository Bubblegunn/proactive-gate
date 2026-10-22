// Email gate for the shop's agent. Shared state lives in STATE_DIR so every
// worker process sees the same opt-outs, and it survives restarts.
//
// Layout: STATE_DIR/email-events/<sha256 of canonical address>/<ms>-<rank>-<uuid>.json
// Each event is its own file, written to a temp name and renamed into place.
// Two workers never edit the same file, and a reader never sees a half-written event.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const EVENTS = 'email-events';
const RANK = { resubscribe: 0, unsubscribe: 1 }; // same timestamp: unsubscribe wins

// Returns the mailbox key for an address, or null when it is not an address.
// Display names ("Ann <<EMAIL>>"), mailto:, case, "+tag" and (for gmail) dots
// are removed, so one person maps to one key.
export function canonicalAddress(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  const angle = s.match(/<([^<>]+)>/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, '').toLowerCase();
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return null;
  let local = s.slice(0, at);
  let domain = s.slice(at + 1).replace(/\.$/, '');
  if (!/^[^\s@<>"]+$/.test(local) || !/^[^\s@<>"]+\.[^\s@<>"]+$/.test(domain)) return null;
  local = local.split('+')[0];
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  if (!local) return null;
  return `${local}@${domain}`;
}

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function keyDir(address) {
  const hash = createHash('sha256').update(address).digest('hex');
  return join(stateDir(), EVENTS, hash);
}

async function record(email, at, type) {
  const address = canonicalAddress(email);
  if (!address) throw new TypeError(`not an email address: ${String(email)}`);
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new TypeError('at must be a valid Date');
  }
  const dir = keyDir(address);
  await mkdir(dir, { recursive: true });
  const base = `${at.getTime()}-${RANK[type]}-${randomUUID()}`;
  const tmp = join(dir, `.tmp-${base}`);
  await writeFile(tmp, JSON.stringify({ type, at: at.toISOString(), address }));
  await rename(tmp, join(dir, `${base}.json`));
}

// Records that the person behind the address unsubscribed at `at`.
export async function recordUnsubscribe(email, at) {
  await record(email, at, 'unsubscribe');
}

// Records that the person signed up again on purpose at `at`.
// It lifts an earlier unsubscribe only if `at` is later than that unsubscribe.
export async function recordResubscribe(email, at) {
  await record(email, at, 'resubscribe');
}

// The newest event for this address (ties: unsubscribe wins), or null.
async function currentState(address) {
  let names;
  try {
    names = await readdir(keyDir(address));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let best = null;
  for (const name of names) {
    const m = /^(-?\d+)-([01])-[0-9a-f-]+\.json$/.exec(name);
    if (!m) continue; // temp files and anything else are skipped
    const ms = Number(m[1]);
    const rank = Number(m[2]);
    if (!best || ms > best.ms || (ms === best.ms && rank > best.rank)) {
      best = { ms, rank };
    }
  }
  if (!best) return null;
  return best.rank === RANK.unsubscribe ? 'unsubscribe' : 'resubscribe';
}

// Called before each email leaves the queue.
// Transactional mail (receipts, password resets) is not blocked by opt-outs.
// Marketing mail is blocked after an unsubscribe. Unknown cases are held.
export async function mayEmail(message, now) {
  if (message?.kind === 'transactional') return { allowed: true, reason: null };
  if (message?.kind !== 'marketing') return { allowed: false, reason: 'unknown_kind' };

  const address = canonicalAddress(message.to);
  if (!address) return { allowed: false, reason: 'unknown_recipient' };

  let state;
  try {
    state = await currentState(address);
  } catch {
    return { allowed: false, reason: 'state_unavailable' };
  }
  if (state === 'unsubscribe') return { allowed: false, reason: 'unsubscribed' };
  return { allowed: true, reason: null };
}
