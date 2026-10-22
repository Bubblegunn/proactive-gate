import { mkdirSync, readFileSync, openSync, closeSync, writeFileSync, fsyncSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// true: marketing needs a recordResubscribe event (explicit opt-in) first.
// false: marketing is allowed unless an unsubscribe is in effect (CAN-SPAM opt-out model).
const REQUIRE_EXPLICIT_OPT_IN = true;

// Maps an address (plain or "Name <addr>" header form) to one key per person.
// Lowercase; "+tag" dropped; gmail dots dropped; googlemail.com -> gmail.com.
// Matching too widely is the safe direction for opt-outs.
function normalizeEmail(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  const angle = s.match(/<([^<>]+)>\s*$/);
  if (angle) s = angle[1].trim();
  s = s.toLowerCase();
  if (/\s/.test(s)) return null;
  const at = s.indexOf('@');
  if (at <= 0 || at !== s.lastIndexOf('@')) return null;
  let local = s.slice(0, at);
  let domain = s.slice(at + 1);
  if (!/^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(domain)) return null;
  if (domain === 'googlemail.com') domain = 'gmail.com';
  local = local.split('+')[0];
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  if (!local) return null;
  return `${local}@${domain}`;
}

// STATE_DIR is read on every call. Created if missing. Returns null if unset.
function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) return null;
  mkdirSync(join(dir, 'optout'), { recursive: true });
  return dir;
}

function logPath(dir, key) {
  const name = createHash('sha256').update(key).digest('hex');
  return join(dir, 'optout', `${name}.jsonl`);
}

// Append-only log: one JSON line per event. No read-modify-write, so two
// workers cannot overwrite each other's events. Fsync so an acknowledged
// unsubscribe survives a crash.
function appendEvent(dir, key, type, at) {
  const fd = openSync(logPath(dir, key), 'a');
  try {
    writeFileSync(fd, JSON.stringify({ type, at: at.toISOString(), key }) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Latest unsubscribe and latest resubscribe, by the provider's `at`.
// Taking the max makes the result independent of arrival order.
// Throws on a corrupt line; the caller then holds marketing (fail closed).
function readState(dir, key) {
  let text;
  try {
    text = readFileSync(logPath(dir, key), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { unsub: null, resub: null };
    throw err;
  }
  let unsub = null;
  let resub = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    const ev = JSON.parse(line);
    const t = new Date(ev.at).getTime();
    if (Number.isNaN(t)) throw new Error('bad event time');
    if (ev.type === 'unsubscribe') unsub = unsub === null ? t : Math.max(unsub, t);
    else if (ev.type === 'resubscribe') resub = resub === null ? t : Math.max(resub, t);
    else throw new Error('bad event type');
  }
  return { unsub, resub };
}

function record(email, at, type) {
  const key = normalizeEmail(email);
  if (!key) throw new TypeError(`${type}: invalid email address`);
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new TypeError(`${type}: invalid at`);
  const dir = stateDir();
  if (!dir) throw new Error('STATE_DIR is not set');
  appendEvent(dir, key, type, at);
}

export function recordUnsubscribe(email, at) {
  record(email, at, 'unsubscribe');
}

// Also the opt-in signal for first-time signups; call it on every explicit signup.
export function recordResubscribe(email, at) {
  record(email, at, 'resubscribe');
}

const ALLOW = { allowed: true, reason: null };
const hold = (reason) => ({ allowed: false, reason });

export function mayEmail(message, now) {
  if (!message || typeof message !== 'object') return hold('invalid_message');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return hold('invalid_now');
  const key = normalizeEmail(message.to);
  if (!key) return hold('invalid_recipient');

  // Transactional (receipts, password resets) is exempt from opt-out under CAN-SPAM.
  if (message.kind === 'transactional') return ALLOW;
  if (message.kind !== 'marketing') return hold('unknown_kind');

  let state;
  try {
    const dir = stateDir();
    if (!dir) return hold('state_unavailable');
    state = readState(dir, key);
  } catch {
    return hold('state_unreadable');
  }

  // Resubscribe counts only if strictly later than the unsubscribe; a tie keeps the opt-out.
  if (state.unsub !== null && (state.resub === null || state.resub <= state.unsub)) {
    return hold('unsubscribed');
  }
  if (REQUIRE_EXPLICIT_OPT_IN && state.resub === null) return hold('no_opt_in');
  return ALLOW;
}
