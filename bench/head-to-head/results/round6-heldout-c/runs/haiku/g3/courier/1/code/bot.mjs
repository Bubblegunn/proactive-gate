// Email consent gate shared by all worker processes on one machine.
//
// State lives only in STATE_DIR. Each mailbox gets its own append-only file
// under STATE_DIR/suppression/, named by the SHA-256 of its canonical address,
// so no plaintext address is stored and workers never rewrite each other's data.
//
// Rules:
// - marketing mail needs an opt-in on record (resubscribe) and no later
//   unsubscribe. EU rules require prior consent, and the address alone does
//   not tell us which country the recipient is in.
// - receipts and other transactional mail are allowed regardless of marketing
//   status.
// - the last valid event in a file wins (file order, not clock time, because
//   worker clocks and call times can differ).
// - a torn or unreadable record after the last valid event blocks marketing
//   until a new valid event is appended (fail closed).

import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';

const KINDS = new Set(['marketing', 'receipt']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR environment variable is not set');
  return dir;
}

// Maps an address to the form used for lookup, so the same mailbox always gets
// the same record: trims, lowercases, drops a trailing dot on the domain,
// strips +tag aliases, and removes dots for gmail.com.
function canonicalKey(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.normalize('NFKC').trim().toLowerCase();
  if (s.length > 254 || !EMAIL_RE.test(s)) return null;
  const at = s.lastIndexOf('@');
  let local = s.slice(0, at);
  let domain = s.slice(at + 1).replace(/\.$/, '');
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  local = local.split('+')[0];
  if (!local || !domain) return null;
  return `${local}@${domain}`;
}

function shardPath(key) {
  const hash = createHash('sha256').update(key).digest('hex');
  return path.join(stateDir(), 'suppression', `${hash}.log`);
}

async function readState(key) {
  let text;
  try {
    text = await readFile(shardPath(key), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { last: null, damagedAfterLast: false };
    throw err;
  }
  let last = null;
  let damagedAfterLast = false;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let rec = null;
    try {
      rec = JSON.parse(line);
    } catch {
      rec = null;
    }
    if (rec && (rec.ev === 'unsubscribe' || rec.ev === 'resubscribe') && typeof rec.at === 'string') {
      last = rec;
      damagedAfterLast = false;
    } else {
      damagedAfterLast = true;
    }
  }
  return { last, damagedAfterLast };
}

// Each record starts with "\n", so a torn write from a killed worker cannot
// merge into the next record. The file is fsynced before the call resolves.
async function appendEvent(key, ev) {
  await mkdir(path.join(stateDir(), 'suppression'), { recursive: true });
  const file = await open(shardPath(key), 'a');
  try {
    await file.appendFile(`\n${JSON.stringify({ ev, at: new Date().toISOString() })}`);
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function unsubscribe(email) {
  const key = canonicalKey(email);
  if (!key) throw new TypeError('unsubscribe: not a valid email address');
  await appendEvent(key, 'unsubscribe');
}

// Call only after the person deliberately signs up again on the website.
export async function resubscribe(email) {
  const key = canonicalKey(email);
  if (!key) throw new TypeError('resubscribe: not a valid email address');
  await appendEvent(key, 'resubscribe');
}

export async function mayEmail(email, kind, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('mayEmail: now must be a valid Date');
  }
  if (!KINDS.has(kind)) {
    return { allowed: false, reason: 'Unknown email kind, so nothing was sent.' };
  }
  const key = canonicalKey(email);
  if (!key) {
    return { allowed: false, reason: 'The address is not a valid email address, so nothing can be sent to it.' };
  }
  if (kind === 'receipt') {
    return {
      allowed: true,
      reason: 'Receipt or other transactional email, which is allowed even after a marketing unsubscribe.',
    };
  }

  const { last, damagedAfterLast } = await readState(key);
  if (damagedAfterLast) {
    return {
      allowed: false,
      reason: 'The consent record for this address is damaged, so marketing email is blocked until support checks it.',
    };
  }
  if (!last) {
    return {
      allowed: false,
      reason: 'No opt-in is on record for this address, and EU rules require prior consent for marketing email.',
    };
  }
  if (last.ev === 'unsubscribe') {
    return {
      allowed: false,
      reason: `This person unsubscribed from marketing email at ${last.at} and must sign up again on the website first.`,
    };
  }
  return {
    allowed: true,
    reason: `Opt-in on record from ${last.at} with no later unsubscribe.`,
  };
}
