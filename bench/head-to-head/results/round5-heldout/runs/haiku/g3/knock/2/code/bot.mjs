// Send-permission rules for the email queue.
//
// Opt-outs are shared between worker processes through STATE_DIR. Each address
// gets its own append-only log file. Workers only ever append, never rewrite,
// so two workers writing at once cannot lose each other's events. Reading
// takes the latest unsubscribe and the latest resubscribe, so arrival order
// does not matter.
//
// Rules:
// - Marketing mail stops at once after an unsubscribe, unless the person
//   resubscribed later (by the provider's clock).
// - Transactional mail (receipts, password resets) is not blocked by opt-outs.
//   CAN-SPAM exempts it, and people expect it.
// - Anything unclear is denied, not sent.

import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { domainToASCII } from 'node:url';

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

// Reduce an address to the key used for opt-out matching. Spellings that can
// reach the same mailbox map to the same key: case, surrounding whitespace,
// display names and angle brackets from headers, +tags, and Gmail dots.
// The cost of a false match is one skipped marketing email. The cost of a
// missed match is a sent email after an opt-out, so matching is broad.
// Returns null when the address is not a usable address.
function suppressionKey(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  const angle = s.match(/<([^<>]*)>/);
  if (angle) s = angle[1].trim();
  s = s.toLowerCase();
  if (/\s/.test(s)) return null;

  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return null;

  let local = s.slice(0, at);
  let domain = domainToASCII(s.slice(at + 1));
  if (!domain || !domain.includes('.')) return null;

  if (GMAIL_DOMAINS.has(domain)) {
    domain = 'gmail.com';
    local = local.replace(/\./g, '');
  }
  local = local.split('+')[0];
  if (!local) return null;

  return `${local}@${domain}`;
}

function requireKey(email) {
  const key = suppressionKey(email);
  if (key === null) throw new TypeError('recordUnsubscribe/recordResubscribe: not a usable email address');
  return key;
}

function requireTime(at) {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new TypeError('at must be a valid Date');
  }
  return at.getTime();
}

function suppressionDir() {
  const stateDir = process.env.STATE_DIR;
  if (!stateDir) throw new Error('STATE_DIR is not set');
  return path.join(stateDir, 'suppression');
}

function logPath(key) {
  const hash = createHash('sha256').update(key).digest('hex');
  return path.join(suppressionDir(), `${hash}.log`);
}

async function appendEvent(key, type, timeMs) {
  await mkdir(suppressionDir(), { recursive: true });
  // The leading newline keeps a record that follows a torn write (a crash in
  // the middle of an earlier append) on its own line, so it still parses.
  const line = `\n${JSON.stringify({ e: type, at: timeMs })}`;
  const handle = await open(logPath(key), 'a');
  try {
    await handle.appendFile(line);
    // Do not report success until the event is on disk.
    await handle.datasync();
  } finally {
    await handle.close();
  }
}

// Returns the latest unsubscribe and resubscribe times for a key, in epoch ms.
// -Infinity means no event of that type.
async function readState(key) {
  let text;
  try {
    text = await readFile(logPath(key), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { unsub: -Infinity, resub: -Infinity };
    throw err;
  }

  let unsub = -Infinity;
  let resub = -Infinity;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // torn write from a crash; the caller never got a success for it
    }
    if (!rec || typeof rec !== 'object') continue;
    if (typeof rec.at !== 'number' || !Number.isFinite(rec.at)) continue;
    if (rec.e === 'u') unsub = Math.max(unsub, rec.at);
    else if (rec.e === 'r') resub = Math.max(resub, rec.at);
  }
  return { unsub, resub };
}

// On an exact tie the unsubscribe wins.
function isOptedOut({ unsub, resub }) {
  return unsub > -Infinity && unsub >= resub;
}

export async function recordUnsubscribe(email, at) {
  await appendEvent(requireKey(email), 'u', requireTime(at));
}

export async function recordResubscribe(email, at) {
  await appendEvent(requireKey(email), 'r', requireTime(at));
}

export async function mayEmail(message, now) {
  const kind = message?.kind;
  if (kind !== 'marketing' && kind !== 'transactional') {
    return { allowed: false, reason: 'unknown_kind' };
  }

  const key = suppressionKey(message.to);
  if (key === null) return { allowed: false, reason: 'invalid_recipient' };

  if (kind === 'transactional') return { allowed: true, reason: null };

  // Opt-outs are applied whatever `now` is. Events with a time after `now`
  // can come from clock skew between the provider and this host.
  if (isOptedOut(await readState(key))) {
    return { allowed: false, reason: 'unsubscribed' };
  }
  return { allowed: true, reason: null };
}
