// Email suppression gate for the proactive agent.
//
// Rules:
// - Marketing mail (newsletters, "we miss you" drafts) stops for a person
//   once they unsubscribe, unless they later sign up again on purpose.
// - Transactional mail (order receipts, password resets) is never blocked
//   by an unsubscribe. CAN-SPAM exempts it, and recipients expect it.
// - Events are ordered by the provider's `at` clock, not by arrival order.
//   On an exact tie the unsubscribe wins (fail closed).
// - Addresses are matched by person, not by string: case, display name,
//   "+tag" and (for gmail.com) dots are ignored.
//
// Storage: one immutable JSON file per event under
// STATE_DIR/email-events/<sha256(identity)>/<ms>-<type>.json.
// Writes go to a temp file and are renamed into place, so every worker sees
// complete records and no locks are needed. Re-recording the same event
// writes the same file name, which makes it idempotent.

import { mkdir, open, readdir, readFile, rename } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

const MESSAGE_KINDS = new Set(['marketing', 'transactional']);
const EVENTS_DIR = 'email-events';

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function assertDate(value, name) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${name} must be a valid Date`);
  }
}

// Returns a stable identity key for the person behind an address, or null
// when the address is not usable.
function identityKey(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.normalize('NFKC').trim();

  // Accept a header form such as "Jane Doe <jane@example.com>".
  const angle = s.match(/<([^<>]*)>$/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, '').toLowerCase();

  if (/\s/.test(s)) return null;
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return null;

  let local = s.slice(0, at);
  let domain = s.slice(at + 1);
  if (domain.includes('@')) return null;

  if (domain === 'googlemail.com') domain = 'gmail.com';
  // "+tag" sub-addresses point at the same mailbox on the major providers.
  local = local.split('+')[0];
  // Gmail ignores dots in the local part.
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  if (!local) return null;

  return `${local}@${domain}`;
}

function hashOf(key) {
  return createHash('sha256').update(key).digest('hex');
}

function eventDirFor(key) {
  return path.join(stateDir(), EVENTS_DIR, hashOf(key));
}

async function writeEvent(email, type, at) {
  assertDate(at, 'at');
  const key = identityKey(email);
  if (!key) throw new TypeError('email is not a usable address');

  const dir = eventDirFor(key);
  await mkdir(dir, { recursive: true });

  const finalPath = path.join(dir, `${at.getTime()}-${type}.json`);
  const tmpPath = path.join(dir, `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  const body = JSON.stringify({ type, at: at.toISOString(), address: email });

  const handle = await open(tmpPath, 'w');
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmpPath, finalPath);
}

// Latest unsubscribe and latest resubscribe, as epoch ms. A resubscribe
// stamped after `now` is ignored: a skewed clock must not re-enable marketing.
async function latestEvents(key, nowMs) {
  const dir = eventDirFor(key);
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
    if (name.startsWith('.') || !name.endsWith('.json')) continue;
    const ev = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
    const t = Date.parse(ev.at);
    if (ev.type === 'unsubscribe') {
      if (unsub === null || t > unsub) unsub = t;
    } else if (ev.type === 'resubscribe' && t <= nowMs) {
      if (resub === null || t > resub) resub = t;
    }
  }
  return { unsub, resub };
}

export async function recordUnsubscribe(email, at) {
  await writeEvent(email, 'unsubscribe', at);
}

export async function recordResubscribe(email, at) {
  await writeEvent(email, 'resubscribe', at);
}

export async function mayEmail(message, now) {
  assertDate(now, 'now');
  const allow = () => ({ allowed: true, reason: null });
  const deny = (reason) => ({ allowed: false, reason });

  const kind = message?.kind;
  if (!MESSAGE_KINDS.has(kind)) return deny('unknown_message_kind');

  const key = identityKey(message.to);
  if (!key) return deny('invalid_recipient');

  if (kind === 'transactional') return allow();

  const { unsub, resub } = await latestEvents(key, now.getTime());
  // Suppressed unless a resubscribe is strictly later than the latest unsubscribe.
  if (unsub !== null && (resub === null || resub <= unsub)) {
    return deny('unsubscribed');
  }
  return allow();
}
