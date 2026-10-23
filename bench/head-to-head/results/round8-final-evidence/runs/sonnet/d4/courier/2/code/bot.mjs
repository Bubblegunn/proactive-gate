// Last-line suppression check for outgoing email.
//
// State lives in $STATE_DIR/suppressions as one empty-ish marker file per
// (address key, event type). A marker is created atomically (write temp file,
// fsync, hard-link to the final name, fsync directory), so concurrent webhook
// workers never corrupt each other and a marker is either fully present or
// absent. Existence of a marker is the whole truth; the content is audit only.
//
// Policy:
//   hard_bounce    -> blocks marketing and transactional (address does not exist)
//   spam_complaint -> blocks marketing; transactional mail is still allowed
//   unsubscribe    -> blocks marketing; transactional mail is still allowed
// Suppressions are permanent and do not depend on `now`.
// Unknown/invalid input fails closed (allowed: false).

import { promises as fs } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { domainToASCII } from 'node:url';
import path from 'node:path';

const TYPES = new Set(['unsubscribe', 'spam_complaint', 'hard_bounce']);
const KINDS = new Set(['marketing', 'transactional']);
const GMAIL = new Set(['gmail.com', 'googlemail.com']);

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return path.join(dir, 'suppressions');
}

// Returns { exact, base } keys or null when the input is not one usable address.
export function normalize(input) {
  if (typeof input !== 'string') return null;
  let s = input.normalize('NFKC').replace(/[​-‍⁠﻿]/g, '').trim();
  if (!s || s.length > 1000) return null;

  // "Display Name <addr@host>" -> addr@host
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, '').trim();
  if (/[\s,;<>()\[\]\\]/.test(s.replace(/^"[^"]*"(?=@)/, 'q'))) return null;

  const at = s.lastIndexOf('@');
  if (at < 1 || at === s.length - 1) return null;
  let local = s.slice(0, at);
  let domain = s.slice(at + 1);
  if (/^"[^"]+"$/.test(local)) local = local.slice(1, -1);
  if (local.includes('@') || local.includes('"')) return null;

  domain = domainToASCII(domain.replace(/\.+$/, '').toLowerCase());
  if (!domain || !domain.includes('.') && !/^\[/.test(domain)) return null;
  local = local.toLowerCase();
  if (!local || local.length > 64 || domain.length > 253) return null;

  if (GMAIL.has(domain)) {
    domain = 'gmail.com';
    local = local.replace(/\./g, '');
  }
  const plus = local.indexOf('+');
  const baseLocal = plus > 0 ? local.slice(0, plus) : local;
  if (!baseLocal) return null;
  return { exact: `${local}@${domain}`, base: `${baseLocal}@${domain}` };
}

const sha = (s) => createHash('sha256').update(s).digest('hex');
const markerName = (scope, key, type) => `${scope}-${sha(key)}.${type}`;

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e; // cannot tell -> caller must not send
  }
}

async function fsyncDir(dir) {
  const fh = await fs.open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function writeMarker(dir, name, body) {
  const final = path.join(dir, name);
  if (await exists(final)) return; // keep the first-seen record
  const tmp = path.join(dir, `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
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
    if (e.code !== 'EEXIST') throw e;
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

export async function recordEvent({ email, type, now } = {}) {
  if (!TYPES.has(type)) throw new TypeError(`unknown event type: ${String(type)}`);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  const keys = normalize(email);
  if (!keys) throw new TypeError(`unusable email address: ${String(email)}`);

  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const body = JSON.stringify({ email, type, at: now.toISOString() }) + '\n';

  await writeMarker(dir, markerName('x', keys.exact, type), body);
  // A person who unsubscribes or complains as name+tag@ does not want marketing
  // at name@ or name+other@ either. Bounces are exact-address facts only.
  if (type !== 'hard_bounce') {
    await writeMarker(dir, markerName('b', keys.base, type), body);
  }
  await fsyncDir(dir);
}

export async function checkEmail({ email, kind, now } = {}) {
  if (!KINDS.has(kind)) return { allowed: false, rule: 'invalid_kind' };
  const keys = normalize(email);
  if (!keys) return { allowed: false, rule: 'invalid_address' };

  const dir = stateDir();
  const has = (scope, key, type) => exists(path.join(dir, markerName(scope, key, type)));

  if (await has('x', keys.exact, 'hard_bounce')) return { allowed: false, rule: 'hard_bounce' };
  if (kind === 'transactional') return { allowed: true, rule: '' };

  const [xc, bc, xu, bu] = await Promise.all([
    has('x', keys.exact, 'spam_complaint'),
    has('b', keys.base, 'spam_complaint'),
    has('x', keys.exact, 'unsubscribe'),
    has('b', keys.base, 'unsubscribe'),
  ]);
  if (xc || bc) return { allowed: false, rule: 'spam_complaint' };
  if (xu || bu) return { allowed: false, rule: 'unsubscribed' };
  return { allowed: true, rule: '' };
}
