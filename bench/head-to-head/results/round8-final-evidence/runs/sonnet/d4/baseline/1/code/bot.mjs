// Last-line email send gate: suppression records shared by many processes
// through files in STATE_DIR.
//
// Policy
//   hard_bounce     -> block ALL mail to that mailbox (marketing and transactional);
//                      sending to a dead address hurts sender reputation.
//   spam_complaint  -> block marketing. Transactional mail is still allowed
//                      (the person needs receipts and password resets, and
//                      CAN-SPAM does not cover transactional messages).
//   unsubscribe     -> block marketing. Transactional is still allowed.
//   Unsubscribe and complaint are permanent; nothing in this API removes them.
//
// Storage: one marker file per (event kind, address key), named
// "sup-<sha256(key)>.<tag>". A marker is created with open(..., "a") and a
// single appended line, so concurrent writers never conflict and a reader
// only needs to test for existence (no partial-JSON problem). Each write is
// fsync'ed (file and directory) before recordEvent resolves.

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { domainToASCII } from 'node:url';

const EVENT_TAGS = {
  unsubscribe: 'unsub',
  spam_complaint: 'spam',
  hard_bounce: 'bounce',
};

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

// Returns { exact, base } or null when the input is not an email address.
//   exact: the mailbox as best we can identify it (used for bounces).
//   base:  exact with any "+tag" removed (used for opt-outs, so that an
//          opt-out by user+a@x also covers user@x and user+b@x).
// Gmail ignores dots and "+tag" and treats googlemail.com as gmail.com.
export function normalizeAddress(input) {
  if (typeof input !== 'string') return null;

  let s = input
    .normalize('NFKC')
    .replace(/[​-‍⁠﻿]/g, '')
    .trim();

  if (/^mailto:/i.test(s)) {
    s = s.slice(7);
    const q = s.indexOf('?');
    if (q !== -1) s = s.slice(0, q);
    try {
      s = decodeURIComponent(s);
    } catch {
      /* keep undecoded */
    }
    s = s.trim();
  }

  // "Display Name <user@example.com>" or "<user@example.com>"
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1].trim();

  const at = s.lastIndexOf('@');
  if (at < 1) return null;

  let local = s.slice(0, at).toLowerCase();
  let domain = s.slice(at + 1).toLowerCase().replace(/\.+$/, '');

  if (local.length === 0 || local.length > 64) return null;
  if (/[\s\u0000-\u001f\u007f@<>(),;:\\"[\]]/.test(local)) return null;

  if (!domain || /[\s\u0000-\u001f\u007f@<>(),;:\\"[\]/]/.test(domain)) return null;
  domain = domainToASCII(domain);
  if (!domain || !domain.includes('.') || domain.length > 253) return null;
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)) {
    return null;
  }

  if (GMAIL_DOMAINS.has(domain)) {
    domain = 'gmail.com';
    const plus = local.indexOf('+');
    if (plus !== -1) local = local.slice(0, plus);
    local = local.replace(/\./g, '');
    if (!local) return null;
    const key = `${local}@${domain}`;
    return { exact: key, base: key };
  }

  const plus = local.indexOf('+');
  const baseLocal = plus > 0 ? local.slice(0, plus) : local;
  return { exact: `${local}@${domain}`, base: `${baseLocal}@${domain}` };
}

function markerPath(dir, key, tag) {
  const hash = createHash('sha256').update(key).digest('hex');
  return path.join(dir, `sup-${hash}.${tag}`);
}

async function exists(file) {
  try {
    await fs.stat(file);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err; // cannot verify -> do not guess; caller must not send
  }
}

async function fsyncDir(dir) {
  let fh;
  try {
    fh = await fs.open(dir, 'r');
    await fh.sync();
  } catch {
    /* directory fsync is not supported everywhere; file fsync already done */
  } finally {
    if (fh) await fh.close();
  }
}

export async function recordEvent({ email, type, now } = {}) {
  const tag = Object.hasOwn(EVENT_TAGS, type) ? EVENT_TAGS[type] : undefined;
  if (!tag) throw new TypeError(`unknown event type: ${String(type)}`);
  const addr = normalizeAddress(email);
  if (!addr) throw new TypeError(`invalid email address: ${String(email)}`);

  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });

  const key = type === 'hard_bounce' ? addr.exact : addr.base;
  let at = null;
  if (now instanceof Date && !Number.isNaN(now.getTime())) at = now.toISOString();
  const line = JSON.stringify({ email: addr.exact, raw: email, type, at }) + '\n';

  const fh = await fs.open(markerPath(dir, key, tag), 'a');
  try {
    await fh.write(line);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsyncDir(dir);
}

export async function checkEmail({ email, kind, now } = {}) {
  if (kind !== 'marketing' && kind !== 'transactional') {
    return { allowed: false, rule: 'invalid_kind' };
  }
  const addr = normalizeAddress(email);
  if (!addr) return { allowed: false, rule: 'invalid_address' };

  const dir = stateDir();

  if (await exists(markerPath(dir, addr.exact, 'bounce'))) {
    return { allowed: false, rule: 'hard_bounce' };
  }

  if (kind === 'marketing') {
    const [spam, unsub] = await Promise.all([
      exists(markerPath(dir, addr.base, 'spam')),
      exists(markerPath(dir, addr.base, 'unsub')),
    ]);
    if (spam) return { allowed: false, rule: 'spam_complaint' };
    if (unsub) return { allowed: false, rule: 'unsubscribed' };
  }

  return { allowed: true, rule: '' };
}
