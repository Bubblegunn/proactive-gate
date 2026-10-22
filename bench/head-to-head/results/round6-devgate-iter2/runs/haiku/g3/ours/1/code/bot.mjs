// Opt-out gate for outgoing email. Shared state lives in STATE_DIR so every
// worker process sees the same unsubscribe and resubscribe events.
// Events are append-only files, one per event, written by temp file + rename,
// so workers never write the same file and a reader never sees a partial one.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

// "Name <<EMAIL>>" and "<EMAIL>" map to the same key.
// Stripping the +tag and Gmail dots only merges addresses, which makes an
// opt-out cover more mailboxes; that is the safe direction.
function canonicalEmail(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  const angle = s.match(/<([^<>]+)>/);
  if (angle) s = angle[1].trim();
  s = s.toLowerCase();
  if (!EMAIL_RE.test(s)) return null;
  const at = s.lastIndexOf('@');
  let local = s.slice(0, at);
  let domain = s.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  local = local.split('+')[0];
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

function hashOf(canon) {
  return createHash('sha256').update(canon).digest('hex');
}

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  mkdirSync(join(dir, 'events'), { recursive: true });
  mkdirSync(join(dir, 'tmp'), { recursive: true });
  return dir;
}

function writeEvent(type, email, at) {
  const canon = canonicalEmail(email);
  if (!canon) throw new TypeError('invalid email address');
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new TypeError('at must be a valid Date');
  }
  const dir = stateDir();
  const userDir = join(dir, 'events', hashOf(canon));
  mkdirSync(userDir, { recursive: true });
  const id = randomBytes(12).toString('hex');
  const tmp = join(dir, 'tmp', `${id}.json`);
  const final = join(userDir, `${at.getTime()}-${type}-${id}.json`);
  writeFileSync(tmp, JSON.stringify({ type, at: at.getTime(), id }));
  renameSync(tmp, final);
}

// Latest unsubscribe and latest resubscribe times for one address.
// Read on every call; nothing is cached.
function latestEvents(canon) {
  const dir = stateDir();
  const userDir = join(dir, 'events', hashOf(canon));
  let latestUnsub = null;
  let latestResub = null;
  if (!existsSync(userDir)) return { latestUnsub, latestResub };
  for (const file of readdirSync(userDir)) {
    if (!file.endsWith('.json')) continue;
    const ev = JSON.parse(readFileSync(join(userDir, file), 'utf8'));
    if (ev.type === 'unsubscribe') {
      latestUnsub = latestUnsub === null ? ev.at : Math.max(latestUnsub, ev.at);
    } else if (ev.type === 'resubscribe') {
      latestResub = latestResub === null ? ev.at : Math.max(latestResub, ev.at);
    }
  }
  return { latestUnsub, latestResub };
}

const allow = () => ({ allowed: true, reason: null });
const refuse = (reason) => ({ allowed: false, reason });

export function recordUnsubscribe(email, at) {
  writeEvent('unsubscribe', email, at);
}

export function recordResubscribe(email, at) {
  writeEvent('resubscribe', email, at);
}

// Unsubscribed unless a resubscribe is strictly later. A tie counts as
// unsubscribed, so a late-arriving resubscribe cannot undo a same-time opt-out.
export function mayEmail(message, _now) {
  try {
    if (!message || typeof message !== 'object') return refuse('invalid_message');
    if (message.kind !== 'marketing' && message.kind !== 'transactional') {
      return refuse('unknown_kind');
    }
    const canon = canonicalEmail(message.to);
    if (!canon) return refuse('invalid_recipient');
    // Receipts and password resets are not marketing; opt-out does not stop them.
    if (message.kind === 'transactional') return allow();
    const { latestUnsub, latestResub } = latestEvents(canon);
    if (latestUnsub !== null && (latestResub === null || latestUnsub >= latestResub)) {
      return refuse('unsubscribed');
    }
    return allow();
  } catch {
    // State unreadable or STATE_DIR unset: fail closed for marketing.
    return refuse('state_unavailable');
  }
}
