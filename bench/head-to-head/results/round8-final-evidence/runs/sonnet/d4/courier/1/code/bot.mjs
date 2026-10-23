// Suppression gate for outgoing email. Shared state is one small file per
// (type, address) in STATE_DIR, so concurrent workers never need a lock.
import { createHash, randomBytes } from 'node:crypto';
import { domainToASCII } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';

const TYPES = new Set(['unsubscribe', 'spam_complaint', 'hard_bounce']);
const KINDS = new Set(['marketing', 'transactional']);
const GMAIL = new Set(['gmail.com', 'googlemail.com']);

// Returns { exact, person } keys, or null when the address is not valid.
//  exact:  the mailbox itself (used for hard bounces: that mailbox does not exist)
//  person: the mailbox without "+tag" (used for opt-outs and complaints, so
//          <EMAIL> cannot dodge an opt-out recorded for <EMAIL>)
function normalize(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.normalize('NFKC').replace(/[​-‍⁠﻿]/g, '').trim();
  const angle = s.match(/<([^<>]*)>\s*$/); // "Name <<EMAIL>>"
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, '').trim();
  if (/[\s\u0000-\u001f<>,;()[\]\\]/.test(s)) return null;
  const at = s.lastIndexOf('@');
  if (at < 1) return null;
  let local = s.slice(0, at).toLowerCase();
  let domain = s.slice(at + 1).toLowerCase().replace(/\.+$/, '');
  if (!domain || !domain.includes('.')) return null;
  domain = domainToASCII(domain);
  if (!domain || !/^[a-z0-9.-]+$/.test(domain) || domain.includes('..')) return null;
  if (/^[0-9.]+$/.test(domain)) return null; // bare IP
  if (local.length > 64 || domain.length > 253) return null;
  if (GMAIL.has(domain)) domain = 'gmail.com';

  const plus = local.indexOf('+');
  let base = plus > 0 ? local.slice(0, plus) : local;
  if (domain === 'gmail.com') {
    base = base.replace(/\./g, '');
    local = base; // Gmail ignores dots and +tag: same mailbox
  }
  if (!base) return null;
  return { exact: `${local}@${domain}`, person: `${base}@${domain}` };
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

async function fsyncDir(dir) {
  let fh;
  try {
    fh = await fs.open(dir, 'r');
    await fh.sync();
  } catch {
    /* directory fsync is not supported everywhere */
  } finally {
    await fh?.close();
  }
}

export async function recordEvent({ email, type, now } = {}) {
  if (!TYPES.has(type)) throw new TypeError(`unknown event type: ${String(type)}`);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  const keys = normalize(email);
  if (!keys) throw new TypeError(`invalid email address: ${String(email)}`);

  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const key = type === 'hard_bounce' ? keys.exact : keys.person;
  const final = fileFor(dir, type, key);
  const tmp = path.join(dir, `.tmp.${process.pid}.${randomBytes(8).toString('hex')}`);
  const body = JSON.stringify({ type, key, at: now.toISOString() });
  try {
    const fh = await fs.open(tmp, 'wx');
    try {
      await fh.writeFile(body);
      await fh.sync();
    } finally {
      await fh.close();
    }
    // link() fails if the name exists: the first event wins, and the final
    // file never appears half-written.
    try {
      await fs.link(tmp, final);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    await fsyncDir(dir);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

// Fails closed: anything we cannot verify is not allowed.
export async function checkEmail({ email, kind, now } = {}) {
  if (!KINDS.has(kind)) return { allowed: false, rule: 'invalid_kind' };
  const keys = normalize(email);
  if (!keys) return { allowed: false, rule: 'invalid_address' };
  try {
    const dir = stateDir();
    // Undeliverable address: nothing may be sent, transactional included.
    if (await exists(fileFor(dir, 'hard_bounce', keys.exact))) {
      return { allowed: false, rule: 'hard_bounce' };
    }
    if (kind === 'marketing') {
      if (await exists(fileFor(dir, 'spam_complaint', keys.person))) {
        return { allowed: false, rule: 'spam_complaint' };
      }
      if (await exists(fileFor(dir, 'unsubscribe', keys.person))) {
        return { allowed: false, rule: 'unsubscribed' };
      }
    }
    return { allowed: true, rule: '' };
  } catch {
    return { allowed: false, rule: 'state_unavailable' };
  }
}
