// Suppression gate for outgoing email.
//
// Policy:
//   hard_bounce     -> block every kind of mail to that exact address (sending to a dead
//                      address hurts sender reputation).
//   spam_complaint  -> block marketing. Transactional mail the person needs stays allowed.
//   unsubscribe     -> block marketing. CAN-SPAM exempts transactional mail from opt-out.
//
// Unsubscribe and complaint apply to the whole mailbox, so they use a loose key
// (case, "+tag", Gmail dots and googlemail.com are ignored). A bounce only says that one
// written address does not exist, so it uses a strict key.
//
// Storage: one small file per (type, key) in STATE_DIR, named by a hash. A file is written
// to a temp name, fsynced, then hard-linked to its final name. Readers never see partial
// files, writers in different processes need no lock, and a check is one stat per key.
// Suppressions never expire, so `now` is only stored for the audit trail.

import { createHash, randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';

const TYPES = new Set(['unsubscribe', 'spam_complaint', 'hard_bounce']);
const KINDS = new Set(['marketing', 'transactional']);
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

// Returns { local, domain } or null when the text is not a usable address.
function parseAddress(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.normalize('NFKC').replace(/[​-‍⁠﻿]/g, '').trim();
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, '').trim();
  if (!s || /[\s\u0000-\u001f<>,;]/.test(s)) return null;
  const at = s.lastIndexOf('@');
  if (at < 1 || at === s.length - 1) return null;
  const local = s.slice(0, at).toLowerCase();
  const domain = domainToASCII(s.slice(at + 1).replace(/\.+$/, '').toLowerCase());
  if (!domain || !domain.includes('.') && !/^\[/.test(domain)) return null;
  return { local, domain };
}

function strictKey({ local, domain }) {
  const d = domain === 'googlemail.com' ? 'gmail.com' : domain;
  return `${local}@${d}`;
}

function looseKey({ local, domain }) {
  let l = local.split('+')[0];
  let d = domain;
  if (GMAIL_DOMAINS.has(d)) {
    l = l.replace(/\./g, '');
    d = 'gmail.com';
  }
  return `${l}@${d}`;
}

function fileFor(dir, type, key) {
  const h = createHash('sha256').update(`${type}\n${key}`).digest('hex');
  return path.join(dir, `${type}-${h}.json`);
}

async function exists(file) {
  try {
    await fs.stat(file);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e; // unreadable state: let the caller fail instead of allowing a send
  }
}

async function writeOnce(dir, file, record) {
  const tmp = path.join(dir, `.tmp-${process.pid}-${randomUUID()}`);
  const fh = await fs.open(tmp, 'wx', 0o644);
  try {
    await fh.writeFile(JSON.stringify(record) + '\n');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.link(tmp, file); // fails with EEXIST if another process already recorded it
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
  try {
    const dh = await fs.open(dir, 'r');
    try { await dh.sync(); } finally { await dh.close(); }
  } catch { /* directory fsync is not supported everywhere */ }
}

export async function recordEvent({ email, type, now } = {}) {
  if (!TYPES.has(type)) throw new Error(`unknown event type: ${type}`);
  const addr = parseAddress(email);
  if (!addr) throw new Error(`invalid email address: ${email}`);
  const when = now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : null;
  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const key = type === 'hard_bounce' ? strictKey(addr) : looseKey(addr);
  await writeOnce(dir, fileFor(dir, type, key), { type, key, email, at: when });
}

export async function checkEmail({ email, kind, now } = {}) {
  if (!KINDS.has(kind)) return { allowed: false, rule: 'invalid_kind' };
  const addr = parseAddress(email);
  if (!addr) return { allowed: false, rule: 'invalid_address' };
  const dir = stateDir();
  const strict = strictKey(addr);
  const loose = looseKey(addr);

  if (await exists(fileFor(dir, 'hard_bounce', strict))) {
    return { allowed: false, rule: 'hard_bounce' };
  }
  if (kind === 'marketing') {
    if (await exists(fileFor(dir, 'spam_complaint', loose))) {
      return { allowed: false, rule: 'spam_complaint' };
    }
    if (await exists(fileFor(dir, 'unsubscribe', loose))) {
      return { allowed: false, rule: 'unsubscribed' };
    }
  }
  return { allowed: true, rule: '' };
}
