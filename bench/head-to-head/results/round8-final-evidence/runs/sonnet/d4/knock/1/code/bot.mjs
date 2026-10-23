import { createHash, randomBytes } from 'node:crypto';
import { domainToASCII } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';

const TYPES = new Set(['unsubscribe', 'spam_complaint', 'hard_bounce']);
const KINDS = new Set(['marketing', 'transactional']);

// Which recorded event blocks which kind of mail.
const BLOCKS = {
  unsubscribe: { marketing: 'unsubscribed' },
  spam_complaint: { marketing: 'spam_complaint' },
  hard_bounce: { marketing: 'hard_bounce', transactional: 'hard_bounce' },
};
// Check order decides which rule is reported when several apply.
const ORDER = ['hard_bounce', 'spam_complaint', 'unsubscribe'];

/**
 * Canonical form of an address, or null if it is not a usable address.
 * Handles case, surrounding whitespace, "Name <a@b>" and "mailto:" forms,
 * full-width / compatibility characters, invisible characters, a trailing
 * dot or IDN form in the domain, and Gmail dots and +tags.
 */
export function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.normalize('NFKC').replace(/[\p{Cf}\p{Cc}]/gu, (c) => (/\s/.test(c) ? ' ' : ''));
  s = s.trim();
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, '').trim();
  s = s.toLowerCase();
  if (!s || /\s/.test(s) || /[<>,;"()\\]/.test(s)) return null;
  const at = s.lastIndexOf('@');
  if (at < 1 || s.indexOf('@') !== at) return null;
  let local = s.slice(0, at);
  let domain = s.slice(at + 1).replace(/\.+$/, '');
  if (!domain) return null;
  domain = domainToASCII(domain);
  if (!domain || !domain.includes('.') || !/^[a-z0-9.-]+$/.test(domain)) return null;
  if (domain.startsWith('.') || domain.includes('..') || domain.startsWith('-')) return null;
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.split('+')[0].replace(/\./g, '');
  if (!local || local.length > 64 || local.length + domain.length + 1 > 254) return null;
  return `${local}@${domain}`;
}

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function fileFor(dir, email, type) {
  const h = createHash('sha256').update(email).digest('hex');
  return path.join(dir, `${h}.${type}.json`);
}

async function fsyncDir(dir) {
  let fh;
  try {
    fh = await fs.open(dir, 'r');
    await fh.sync();
  } catch {
    // directory fsync is not supported everywhere
  } finally {
    await fh?.close();
  }
}

export async function recordEvent({ email, type, now } = {}) {
  if (!TYPES.has(type)) throw new Error(`unknown event type: ${String(type)}`);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('now must be a valid Date');
  const norm = normalizeEmail(email);
  if (!norm) throw new Error(`invalid email address: ${String(email)}`);
  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const target = fileFor(dir, norm, type);
  const tmp = path.join(dir, `.tmp-${process.pid}-${randomBytes(8).toString('hex')}`);
  const body = JSON.stringify({ email: norm, rawEmail: email, type, at: now.toISOString() });
  const fh = await fs.open(tmp, 'wx');
  try {
    await fh.writeFile(body);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    // link fails if the event is already recorded; the first record is kept.
    await fs.link(tmp, target);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
  await fsyncDir(dir);
}

async function exists(file) {
  try {
    await fs.stat(file);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

export async function checkEmail({ email, kind, now } = {}) {
  if (!KINDS.has(kind)) return { allowed: false, rule: 'invalid_kind' };
  const norm = normalizeEmail(email);
  if (!norm) return { allowed: false, rule: 'invalid_address' };
  try {
    const dir = stateDir();
    for (const type of ORDER) {
      const rule = BLOCKS[type][kind];
      if (rule && (await exists(fileFor(dir, norm, type)))) return { allowed: false, rule };
    }
  } catch {
    // cannot read suppression state: do not send
    return { allowed: false, rule: 'state_unavailable' };
  }
  return { allowed: true, rule: '' };
}
