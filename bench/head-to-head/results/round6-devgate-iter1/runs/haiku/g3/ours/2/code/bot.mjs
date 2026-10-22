// Unsubscribe gate for outbound email. Decides only; never sends.
// State lives in STATE_DIR so every worker process sees the same opt-outs.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const UNSUBSCRIBE = 'unsubscribe';
const RESUBSCRIBE = 'resubscribe';
const EVENT_NAME = /^(-?\d+)-(unsubscribe|resubscribe)\.json$/;

// Address as typed or as in a header ("Name <<EMAIL>>") -> one key per person.
// Lowercased; "+tag" dropped; gmail dots and googlemail.com folded into gmail.com.
// Unknown or malformed input returns null.
export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  const angle = /<([^<>]+)>\s*$/.exec(s);
  if (angle) s = angle[1].trim();
  s = s.toLowerCase();
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return null;
  let local = s.slice(0, at);
  let domain = s.slice(at + 1);
  if (/\s/.test(local + domain) || !domain.includes('.')) return null;
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

function keyDir(root, key) {
  const hash = createHash('sha256').update(key).digest('hex');
  return path.join(root, 'events', hash);
}

function assertDate(at) {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new TypeError('at must be a valid Date');
  }
}

// One file per event, named by provider time and type. Same event twice
// produces the same name, so a repeat is a harmless overwrite. Written to a
// temp file and renamed, so a reader never sees a partial file.
async function record(type, email, at) {
  assertDate(at);
  const key = normalizeEmail(email);
  if (!key) throw new TypeError('email is not a valid address');
  const root = stateDir();
  const dir = keyDir(root, key);
  const tmpDir = path.join(root, 'tmp');
  await mkdir(dir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, randomUUID());
  await writeFile(tmp, JSON.stringify({ type, email: key, at: at.toISOString() }));
  await rename(tmp, path.join(dir, `${at.getTime()}-${type}.json`));
}

export async function recordUnsubscribe(email, at) {
  return record(UNSUBSCRIBE, email, at);
}

export async function recordResubscribe(email, at) {
  return record(RESUBSCRIBE, email, at);
}

// The latest event by provider time decides. At an equal time, unsubscribe wins.
// Arrival order does not matter.
async function currentState(key) {
  const dir = keyDir(stateDir(), key);
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return 'none';
    throw err;
  }
  let latest = null;
  for (const name of names) {
    const m = EVENT_NAME.exec(name);
    if (!m) continue;
    const ms = Number(m[1]);
    const type = m[2];
    if (!latest || ms > latest.ms || (ms === latest.ms && type === UNSUBSCRIBE)) {
      latest = { ms, type };
    }
  }
  if (!latest) return 'none';
  return latest.type === UNSUBSCRIBE ? 'unsubscribed' : 'resubscribed';
}

function allowed() {
  return { allowed: true, reason: null };
}

function held(reason) {
  return { allowed: false, reason };
}

// `now` is accepted for the queue's signature. The decision uses event times,
// not the send time, so it is not read here.
export async function mayEmail(message, now) {
  const kind = message?.kind;
  if (kind !== 'marketing' && kind !== 'transactional') return held('invalid_kind');
  const key = normalizeEmail(message?.to);
  if (!key) return held('invalid_recipient');
  // Order receipts and password resets are transactional: opt-out does not stop them.
  if (kind === 'transactional') return allowed();
  let state;
  try {
    state = await currentState(key);
  } catch {
    // Fail closed: with no readable opt-out state, a marketing send is held.
    return held('state_unavailable');
  }
  if (state === 'unsubscribed') return held('unsubscribed');
  return allowed();
}
