// Opt-out gate for outgoing email. All state lives in STATE_DIR so every
// worker process on the machine sees the same unsubscribe/resubscribe history.
//
// Storage: one append-only JSONL file per person, named by the SHA-256 of the
// canonical address. Each record is written with O_APPEND and fsynced. Records
// are never rewritten, so two workers appending at once cannot lose each
// other's events, and a restart loses nothing that was acknowledged.
//
// Decision rule (marketing only):
//   the latest "unsubscribe" must be later than the latest "resubscribe".
//   Ties go to unsubscribe. Arrival order is ignored, only `at` counts.
//
// Transactional mail (order receipts, password resets) is not blocked by an
// unsubscribe. CAN-SPAM (15 U.S.C. 7702(17)) defines "transactional or
// relationship messages" and applies the opt-out rules to commercial messages
// only. The people on the list expect receipts and resets to keep arriving.

import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const EVENT_DIR = 'optout-events';
const MESSAGE_KINDS = new Set(['marketing', 'transactional']);

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

// Returns the identity key for an address, or null if it is not usable.
// Accepts a bare address, "Name <addr>" header form, and mailto: links.
// Plus-tags are dropped for every domain, and Gmail dots are dropped too.
// This makes suppression match more addresses, which is the safe direction
// for an opt-out.
export function canonicalAddress(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().replace(/^mailto:/i, '').trim();
  const angled = s.match(/<([^<>]+)>\s*$/);
  if (angled) s = angled[1].trim();
  if (/\s/.test(s)) return null;

  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return null;

  let local = s.slice(0, at).toLowerCase().split('+')[0];
  let domain = s.slice(at + 1).toLowerCase().replace(/\.$/, '');
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  if (!local || !domain.includes('.')) return null;
  return `${local}@${domain}`;
}

function eventFile(key) {
  const hash = createHash('sha256').update(key).digest('hex');
  return path.join(stateDir(), EVENT_DIR, `${hash}.jsonl`);
}

async function appendEvent(email, type, at) {
  const key = canonicalAddress(email);
  if (!key) throw new TypeError(`invalid email address: ${String(email)}`);
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new TypeError('at must be a valid Date');
  }

  const file = eventFile(key);
  await fs.mkdir(path.dirname(file), { recursive: true });

  // Leading newline: if a worker was killed mid-write, the torn fragment is
  // ended by this newline and does not corrupt the record that follows.
  const line = '\n' + JSON.stringify({
    id: randomUUID(),
    type,
    key,
    at: at.toISOString(),
  }) + '\n';

  const handle = await fs.open(file, 'a');
  try {
    await handle.writeFile(line);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Reads every event for one address. Lines that do not parse are skipped:
// they are torn writes from killed workers, and the write that caused them
// never returned to its caller.
async function readEvents(key) {
  let text;
  try {
    text = await fs.readFile(eventFile(key), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const events = { unsubscribe: -Infinity, resubscribe: -Infinity };
  for (const line of text.split('\n')) {
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev || !Object.hasOwn(events, ev.type) || typeof ev.at !== 'string') continue;
    const t = Date.parse(ev.at);
    if (!Number.isNaN(t) && t > events[ev.type]) events[ev.type] = t;
  }
  return events;
}

export async function recordUnsubscribe(email, at) {
  await appendEvent(email, 'unsubscribe', at);
}

export async function recordResubscribe(email, at) {
  await appendEvent(email, 'resubscribe', at);
}

// `now` is accepted for the call contract but not used. Opt-outs stay in force
// until a later explicit resubscribe, so the decision does not depend on
// the clock of the worker making the check.
export async function mayEmail(message, now) {
  const kind = message?.kind;
  if (!MESSAGE_KINDS.has(kind)) {
    return { allowed: false, reason: 'unknown_message_kind' };
  }

  const key = canonicalAddress(message.to);
  if (!key) {
    return { allowed: false, reason: 'invalid_recipient' };
  }

  if (kind === 'transactional') {
    return { allowed: true, reason: null };
  }

  const events = await readEvents(key);
  if (events.unsubscribe !== -Infinity && events.unsubscribe >= events.resubscribe) {
    return { allowed: false, reason: 'unsubscribed' };
  }
  return { allowed: true, reason: null };
}
