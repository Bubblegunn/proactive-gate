import { createHash, randomBytes } from 'node:crypto';
import { domainToASCII } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';

// Suppression gate. One small file per (address, event type) in STATE_DIR.
// A file is written under a temporary name, flushed, then link()ed to its final
// name. link() fails if the name exists, so concurrent writers cannot corrupt
// anything and readers never see a partial file.
//
// Policy:
//   unsubscribe, spam_complaint -> block "marketing"; "transactional" stays allowed
//     (CAN-SPAM exempts mail the person needs; no event can re-subscribe an address).
//   hard_bounce -> block both kinds (the mailbox does not exist).

const TYPES = new Set(['unsubscribe', 'spam_complaint', 'hard_bounce']);
const GMAIL = new Set(['gmail.com', 'googlemail.com']);

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

// Returns { strict, loose } or null.
//   loose:  also removes "+tag" (all domains) and dots (Gmail); used for opt-outs,
//           so over-matching only ever means less marketing mail.
//   strict: the mailbox identity; used for bounces so a bounce on one
//           alias does not block unrelated mailboxes at other domains.
export function normalizeEmail(input) {
  if (typeof input !== 'string') return null;
  let s = input.normalize('NFKC').replace(/[\u0000-\u001f\u007f​-‍⁠﻿]/g, '').trim();
  s = s.replace(/^mailto:/i, '');
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1];
  s = s.trim();
  const at = s.lastIndexOf('@');
  if (at < 1) return null;
  let local = s.slice(0, at).toLowerCase();
  let domain = s.slice(at + 1).replace(/\.+$/, '').toLowerCase();
  if (!local || !domain || /[\s@<>,;"()[\]\\]/.test(local + domain)) return null;
  domain = domainToASCII(domain);
  if (!domain || !/^[a-z0-9.-]+$/.test(domain) || domain.startsWith('.') || domain.includes('..')) return null;
  if (domain === 'googlemail.com') domain = 'gmail.com';

  const plus = local.indexOf('+');
  const base = plus > 0 ? local.slice(0, plus) : local;
  const gmail = GMAIL.has(domain);
  const loose = `${gmail ? base.replace(/\./g, '') || base : base}@${domain}`;
  const strict = gmail ? loose : `${local}@${domain}`;
  return { strict, loose };
}

const fileFor = (dir, key, type) =>
  path.join(dir, `${createHash('sha256').update(key).digest('hex')}.${type}.json`);

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

async function syncDir(dir) {
  let fh;
  try {
    fh = await fs.open(dir, 'r');
    await fh.sync();
  } catch {
    // some platforms cannot fsync directories
  } finally {
    await fh?.close();
  }
}

export async function recordEvent({ email, type, now } = {}) {
  if (!TYPES.has(type)) throw new TypeError(`unknown event type: ${type}`);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  const n = normalizeEmail(email);
  if (!n) throw new TypeError(`invalid email address: ${email}`);

  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const final = fileFor(dir, type === 'hard_bounce' ? n.strict : n.loose, type);
  if (await exists(final)) return; // first record wins, repeats are no-ops

  const tmp = path.join(dir, `.tmp-${process.pid}-${randomBytes(8).toString('hex')}`);
  const body = JSON.stringify({ email: String(email), type, at: now.toISOString() });
  try {
    const fh = await fs.open(tmp, 'wx');
    try {
      await fh.writeFile(body);
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await fs.link(tmp, final);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e; // another worker recorded it first
    }
    await syncDir(dir);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

export async function checkEmail({ email, kind, now } = {}) {
  if (kind !== 'marketing' && kind !== 'transactional') return { allowed: false, rule: 'invalid_kind' };
  const n = normalizeEmail(email);
  if (!n) return { allowed: false, rule: 'invalid_address' };
  try {
    const dir = stateDir();
    if (await exists(fileFor(dir, n.strict, 'hard_bounce'))) return { allowed: false, rule: 'hard_bounce' };
    if (kind === 'marketing') {
      if (await exists(fileFor(dir, n.loose, 'spam_complaint'))) return { allowed: false, rule: 'spam_complaint' };
      if (await exists(fileFor(dir, n.loose, 'unsubscribe'))) return { allowed: false, rule: 'unsubscribed' };
    }
  } catch {
    return { allowed: false, rule: 'state_unavailable' }; // fail closed
  }
  return { allowed: true, rule: '' };
}
