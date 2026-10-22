// Marketing-email suppression ledger shared by every worker through STATE_DIR.
//
// Storage: one append-only JSONL file per mailbox under STATE_DIR/suppression/.
// Each worker only appends, and every decision re-reads the file, so no worker
// holds state that another worker could miss after a restart.
//
// Rules: a marketing message is blocked while the latest unsubscribe is not
// older than the latest resubscribe. Transactional mail (receipts, password
// resets) is never blocked by an unsubscribe.

import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { domainToASCII } from 'node:url';

const LEDGER_DIR = 'suppression';

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

// Maps a typed address or a header value ("Name <<EMAIL>>", "mailto:<EMAIL>")
// to one canonical key. Returns null when the input is not a usable address.
function normalizeEmail(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, '').trim();
  if (/[\s<>,;"()[\]\\]/.test(s)) return null;

  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return null;

  let local = s.slice(0, at).toLowerCase();
  if (local.includes('@')) return null;
  let domain = domainToASCII(s.slice(at + 1).toLowerCase());
  if (!domain || !domain.includes('.')) return null;

  // Same mailbox, different spelling: "+tag" aliases on any domain, and
  // dots/googlemail.com on Gmail. Unsubscribes must follow the person, so
  // these all map to one key.
  local = local.split('+')[0];
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  if (!local) return null;

  return `${local}@${domain}`;
}

function ledgerPath(dir, key) {
  const hash = createHash('sha256').update(key).digest('hex');
  return path.join(dir, LEDGER_DIR, hash.slice(0, 2), `${hash}.jsonl`);
}

function requireDate(value, name) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${name} must be a valid Date`);
  }
}

// Each record starts with "\n". If a crash left a half-written line at the end
// of the file, the next record still begins on a fresh line, and the reader
// skips the broken fragment.
async function appendEvent(email, type, at) {
  const key = normalizeEmail(email);
  if (!key) throw new TypeError(`not a usable email address: ${String(email)}`);
  requireDate(at, 'at');

  const file = ledgerPath(stateDir(), key);
  await mkdir(path.dirname(file), { recursive: true });

  const record = {
    v: 1,
    type,
    email: key,
    at: at.toISOString(),
    recordedAt: new Date().toISOString(),
  };
  const handle = await open(file, 'a');
  try {
    await handle.appendFile('\n' + JSON.stringify(record));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDir(path.dirname(file));
}

// Best effort: makes a newly created ledger file's directory entry durable.
// Some filesystems do not support directory fsync, so errors are ignored.
async function syncDir(dir) {
  try {
    const handle = await open(dir, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // ignored on purpose
  }
}

async function readEvents(email) {
  const key = normalizeEmail(email);
  let text;
  try {
    text = await readFile(ledgerPath(stateDir(), key), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const events = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // half-written line left by a crash
    }
    if (record?.email !== key) continue;
    if (record.type !== 'unsubscribe' && record.type !== 'resubscribe') continue;
    const at = new Date(record.at).getTime();
    if (Number.isNaN(at)) continue;
    events.push({ type: record.type, at });
  }
  return events;
}

// Events arrive late and out of order, so the decision uses the provider's
// timestamps, not arrival order. A resubscribe stamped after `nowMs` (clock
// skew) is not yet in effect. An unsubscribe always counts, which errs toward
// suppression. When an unsubscribe and a resubscribe share a timestamp, the
// unsubscribe wins.
function isUnsubscribed(events, nowMs) {
  let lastUnsubscribe = -Infinity;
  let lastResubscribe = -Infinity;
  for (const event of events) {
    if (event.type === 'unsubscribe') {
      lastUnsubscribe = Math.max(lastUnsubscribe, event.at);
    } else if (event.at <= nowMs) {
      lastResubscribe = Math.max(lastResubscribe, event.at);
    }
  }
  return lastUnsubscribe !== -Infinity && lastUnsubscribe >= lastResubscribe;
}

export async function recordUnsubscribe(email, at) {
  await appendEvent(email, 'unsubscribe', at);
}

// Call this only for an explicit opt-in to marketing (for example the signup
// checkbox). Receipts, password resets and other transactional mail must not
// call it, because they are not consent to marketing.
export async function recordResubscribe(email, at) {
  await appendEvent(email, 'resubscribe', at);
}

export async function mayEmail(message, now) {
  requireDate(now, 'now');

  const kind = message?.kind;
  if (kind !== 'marketing' && kind !== 'transactional') {
    return { allowed: false, reason: 'unknown_message_kind' };
  }
  if (!normalizeEmail(message.to)) {
    return { allowed: false, reason: 'invalid_recipient' };
  }

  // Transactional mail (order receipts, password resets) is expected by the
  // customer whatever their marketing preference, so it does not depend on
  // the ledger.
  if (kind === 'transactional') {
    return { allowed: true, reason: null };
  }

  const events = await readEvents(message.to);
  if (isUnsubscribed(events, now.getTime())) {
    return { allowed: false, reason: 'unsubscribed' };
  }
  return { allowed: true, reason: null };
}
