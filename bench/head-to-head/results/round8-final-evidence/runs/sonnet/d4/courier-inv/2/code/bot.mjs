// Last-check gate before an email is sent.
//
// Policy:
//   hard_bounce    -> block all mail (marketing and transactional) to that mailbox
//   spam_complaint -> block marketing; transactional (receipts, resets) still allowed
//   unsubscribe    -> block marketing; transactional still allowed
// Records are permanent. There is no event that lifts them.
//
// Storage: one small file per (address, type) in STATE_DIR, named by hash.
// Each file is written to a temp name, fsynced, then renamed into place, so
// concurrent writers never corrupt anything and recording twice is harmless.
// No locks and no shared read-modify-write file are needed.

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { domainToASCII } from 'node:url';

const TYPES = new Set(['unsubscribe', 'spam_complaint', 'hard_bounce']);
const GMAIL = new Set(['gmail.com', 'googlemail.com']);

// Returns { exact, loose } keys, or null when the address cannot be parsed.
// exact: the mailbox as far as we can tell (gmail dots/+tag folded, since Gmail ignores them).
// loose: exact with any "+tag" removed on every domain; a person who unsubscribes
//        from <EMAIL> is treated as unsubscribing <EMAIL>.
function normalizeAddress(input) {
  if (typeof input !== 'string') return null;
  let s = input.normalize('NFKC').trim();
  s = s.replace(/^mailto:/i, '');
  // "Display Name <user@host>"
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1].trim();
  if (!s || /[\s\u0000-\u001f<>,;()\\]/.test(s.replace(/^"[^"]*"(?=@)/, 'q'))) return null;

  const at = s.lastIndexOf('@');
  if (at < 1 || at === s.length - 1) return null;
  let local = s.slice(0, at);
  let domain = s.slice(at + 1);

  if (/^"[^"]*"$/.test(local)) local = local.slice(1, -1);
  if (!local || /\s/.test(local)) return null;

  domain = domain.replace(/\.+$/, '');
  if (domain.startsWith('[')) return null; // IP literals are not supported
  domain = domainToASCII(domain.toLowerCase());
  if (!domain || !domain.includes('.') || domain.includes('@')) return null;

  local = local.toLowerCase();
  if (GMAIL.has(domain)) {
    domain = 'gmail.com';
    local = local.replace(/\./g, '');
  }
  const plus = local.indexOf('+');
  const base = plus > 0 ? local.slice(0, plus) : local;
  return { exact: `${local}@${domain}`, loose: `${base}@${domain}` };
}

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function fileFor(dir, type, key) {
  const h = createHash('sha256').update(key).digest('hex');
  return path.join(dir, `${type}.${h}.json`);
}

async function exists(file) {
  try {
    await fs.stat(file);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

async function fsyncDir(dir) {
  let fh;
  try {
    fh = await fs.open(dir, 'r');
    await fh.sync();
  } catch {
    // Directory fsync is not supported everywhere; the file itself is already synced.
  } finally {
    await fh?.close();
  }
}

export async function recordEvent({ email, type, now } = {}) {
  if (!TYPES.has(type)) throw new TypeError(`unknown event type: ${String(type)}`);
  const n = normalizeAddress(email);
  if (!n) throw new TypeError(`unparseable email address: ${String(email)}`);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }

  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });

  const key = type === 'hard_bounce' ? n.exact : n.loose;
  const file = fileFor(dir, type, key);
  if (await exists(file)) return; // first record wins; nothing to change

  const tmp = path.join(dir, `.tmp.${process.pid}.${randomBytes(8).toString('hex')}`);
  const body = JSON.stringify({ type, key, at: now.toISOString() });
  const fh = await fs.open(tmp, 'wx');
  try {
    await fh.writeFile(body);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
  await fsyncDir(dir);
}

export async function checkEmail({ email, kind, now } = {}) {
  const n = normalizeAddress(email);
  if (!n) return { allowed: false, rule: 'invalid_address' };
  if (kind !== 'marketing' && kind !== 'transactional') {
    return { allowed: false, rule: 'invalid_kind' };
  }

  const dir = stateDir();
  // A mailbox that does not exist is blocked for every kind of mail.
  if (await exists(fileFor(dir, 'hard_bounce', n.exact))) {
    return { allowed: false, rule: 'hard_bounce' };
  }
  if (kind === 'marketing') {
    if (await exists(fileFor(dir, 'spam_complaint', n.loose))) {
      return { allowed: false, rule: 'spam_complaint' };
    }
    if (await exists(fileFor(dir, 'unsubscribe', n.loose))) {
      return { allowed: false, rule: 'unsubscribed' };
    }
  }
  return { allowed: true, rule: '' };
}
