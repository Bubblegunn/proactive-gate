// Opt-out gate for outgoing email. All state lives under STATE_DIR so every
// worker process (and every restart) sees the same history.
//
// Layout: STATE_DIR/optouts/<sha256(person key)>.jsonl
// Each file is append-only. Every line is one event: { op, email, at }, where
// `at` is epoch milliseconds from the provider's clock. Nothing is rewritten,
// so events that arrive late or out of order are simply ordered by `at` when
// the decision is made.

import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const UNSUBSCRIBE = 'unsubscribe';
const RESUBSCRIBE = 'resubscribe';
const MARKETING = 'marketing';
const TRANSACTIONAL = 'transactional';

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

// Maps an address (bare, "Name <addr>", or mailto:) to one key per person.
// Returns null when the input is not a usable address.
function personKey(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.normalize('NFKC').trim();
  const angle = s.match(/<([^<>]+)>\s*$/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, '').toLowerCase();
  if (s === '' || /\s/.test(s)) return null;

  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return null;
  let local = s.slice(0, at);
  let domain = s.slice(at + 1);

  // Gmail ignores dots and treats googlemail.com as the same mailbox.
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  // "+tag" sub-addresses reach the same person. Dropping them is the safer
  // error: an extra suppression is cheaper than emailing someone who opted out.
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);

  if (local === '') return null;
  return `${local}@${domain}`;
}

function pathFor(key) {
  const digest = createHash('sha256').update(key).digest('hex');
  return join(stateDir(), 'optouts', `${digest}.jsonl`);
}

function toMillis(at) {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new TypeError('at must be a valid Date');
  }
  return at.getTime();
}

async function append(email, op, at) {
  const file = pathFor(email);
  await mkdir(join(stateDir(), 'optouts'), { recursive: true });
  // O_APPEND keeps concurrent writes from different workers from overwriting
  // each other. sync() makes the event survive a crash or restart.
  const fh = await open(file, 'a');
  try {
    await fh.appendFile(JSON.stringify({ op, email, at: toMillis(at) }) + '\n');
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// Returns the latest unsubscribe and resubscribe times for one person (ms or null).
async function readHistory(email) {
  let text;
  try {
    text = await readFile(pathFor(email), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { unsubAt: null, resubAt: null };
    throw err;
  }
  let unsubAt = null;
  let resubAt = null;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      // A torn line from a write still in progress. Its writer has not
      // returned yet, so no caller has been told it is recorded.
      continue;
    }
    if (ev.op === UNSUBSCRIBE) unsubAt = Math.max(unsubAt ?? ev.at, ev.at);
    else if (ev.op === RESUBSCRIBE) resubAt = Math.max(resubAt ?? ev.at, ev.at);
  }
  return { unsubAt, resubAt };
}

// Unsubscribed unless a resubscribe is strictly later than the latest
// unsubscribe. A tie goes to the unsubscribe.
function isUnsubscribed({ unsubAt, resubAt }) {
  return unsubAt !== null && (resubAt === null || resubAt <= unsubAt);
}

export async function recordUnsubscribe(email, at) {
  const key = personKey(email);
  if (key === null) throw new TypeError('email is not a usable address');
  await append(key, UNSUBSCRIBE, at);
}

export async function recordResubscribe(email, at) {
  const key = personKey(email);
  if (key === null) throw new TypeError('email is not a usable address');
  await append(key, RESUBSCRIBE, at);
}

// Marketing mail stops for anyone who unsubscribed and has not signed up
// again since. Transactional mail (order receipts, password resets) is not
// marketing and is not blocked by an opt-out.
// Reads are not cached, so each call sees the latest events from all workers.
// `now` is validated but does not change the decision.
export async function mayEmail(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  const kind = message?.kind;
  if (kind !== MARKETING && kind !== TRANSACTIONAL) {
    return { allowed: false, reason: 'unknown_kind' };
  }
  const key = personKey(message?.to);
  if (key === null) return { allowed: false, reason: 'invalid_recipient' };

  if (kind === TRANSACTIONAL) return { allowed: true, reason: null };

  if (isUnsubscribed(await readHistory(key))) {
    return { allowed: false, reason: 'unsubscribed' };
  }
  return { allowed: true, reason: null };
}
