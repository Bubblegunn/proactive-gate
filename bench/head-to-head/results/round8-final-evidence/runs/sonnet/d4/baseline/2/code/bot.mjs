import { mkdir, open, link, unlink, access, constants } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { domainToASCII } from 'node:url';
import path from 'node:path';

// State layout: one tiny file per (scope, event type), named by a hash of the address key.
// A file is created with a temp file + link(), so it appears complete and atomically,
// and a second writer (same or other process) just sees EEXIST. No locks, no read-modify-write.
// Events are permanent: there is no resubscribe event.

const EVENT_TYPES = new Set(['unsubscribe', 'spam_complaint', 'hard_bounce']);
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

// Returns { full, base } or null when the text is not one usable address.
//   full: canonical mailbox (Gmail dots and +tags removed, googlemail.com = gmail.com)
//   base: full with any +tag removed on every domain (person-level key for marketing opt-outs)
export function normalizeEmail(input) {
  if (typeof input !== 'string') return null;
  let s = input.normalize('NFKC').replace(/[\u0000-\u001f\u007f​-‍⁠﻿]/g, '').trim();
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, '').trim();
  s = s.replace(/^"(.*)"$/, '$1').trim();
  const at = s.lastIndexOf('@');
  if (at < 1 || at === s.length - 1) return null;
  let local = s.slice(0, at).toLowerCase();
  let domain = s.slice(at + 1).toLowerCase().replace(/\.+$/, '');
  if (/[\s<>,;:"()\[\]\\@]/.test(domain) || /\s/.test(local)) return null;
  domain = domainToASCII(domain);
  if (!domain || !domain.includes('.')) return null;
  if (GMAIL_DOMAINS.has(domain)) {
    domain = 'gmail.com';
    local = local.split('+')[0].replace(/\./g, '');
  }
  const stripped = local.split('+')[0];
  const baseLocal = stripped || local;
  if (!local || !baseLocal) return null;
  return { full: `${local}@${domain}`, base: `${baseLocal}@${domain}` };
}

function fileFor(dir, scope, key) {
  return path.join(dir, `${scope}-${createHash('sha256').update(key).digest('hex')}`);
}

// Which (scope, key) a given event type is stored under.
function slotFor(type, addr) {
  if (type === 'hard_bounce') return { scope: 'bounce', key: addr.full };
  if (type === 'spam_complaint') return { scope: 'complaint', key: addr.base };
  return { scope: 'unsub', key: addr.base };
}

async function fsyncDir(dir) {
  let fh;
  try {
    fh = await open(dir, 'r');
    await fh.sync();
  } catch {
    // directory fsync is not supported everywhere; the file itself was already synced
  } finally {
    await fh?.close();
  }
}

export async function recordEvent({ email, type, now } = {}) {
  if (!EVENT_TYPES.has(type)) throw new TypeError(`unknown event type: ${String(type)}`);
  const addr = normalizeEmail(email);
  if (!addr) throw new TypeError(`unusable email address: ${String(email)}`);
  const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : null;

  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const { scope, key } = slotFor(type, addr);
  const target = fileFor(dir, scope, key);
  const tmp = path.join(dir, `.tmp-${process.pid}-${randomBytes(8).toString('hex')}`);
  try {
    const fh = await open(tmp, 'wx', 0o644);
    try {
      await fh.writeFile(JSON.stringify({ email: key, type, at }) + '\n');
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await link(tmp, target); // atomic; fails if another event already recorded
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  } finally {
    await unlink(tmp).catch(() => {});
  }
  await fsyncDir(dir);
}

async function exists(file) {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

export async function checkEmail({ email, kind, now } = {}) {
  if (kind !== 'marketing' && kind !== 'transactional') return { allowed: false, rule: 'unknown_kind' };
  const addr = normalizeEmail(email);
  if (!addr) return { allowed: false, rule: 'invalid_address' };

  let dir;
  try {
    dir = stateDir();
    // Hard bounce: address does not exist, nothing may be sent to it.
    if (await exists(fileFor(dir, 'bounce', addr.full))) return { allowed: false, rule: 'hard_bounce' };
    if (kind === 'marketing') {
      if (await exists(fileFor(dir, 'complaint', addr.base))) return { allowed: false, rule: 'spam_complaint' };
      if (await exists(fileFor(dir, 'unsub', addr.base))) return { allowed: false, rule: 'unsubscribed' };
    }
  } catch {
    return { allowed: false, rule: 'state_unavailable' }; // fail closed
  }
  return { allowed: true, rule: '' };
}
