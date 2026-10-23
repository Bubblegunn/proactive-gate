import { createHash, randomBytes } from 'node:crypto';
import { domainToASCII } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';

const TYPES = new Set(['unsubscribe', 'spam_complaint', 'hard_bounce']);
const KINDS = new Set(['marketing', 'transactional']);

// Which event types block which kind of mail, in the order they are reported.
const BLOCKS = [
  { type: 'hard_bounce', rule: 'hard-bounce', kinds: ['marketing', 'transactional'] },
  { type: 'spam_complaint', rule: 'spam-complaint', kinds: ['marketing'] },
  { type: 'unsubscribe', rule: 'unsubscribed', kinds: ['marketing'] },
];

// Reduce the many ways one mailbox can be written to a single canonical key.
// Returns null when the input is not a usable address.
export function normalizeEmail(input) {
  if (typeof input !== 'string') return null;
  let s = input.normalize('NFKC').replace(/[​-‍⁠﻿]/g, '').trim();
  // "Display Name <<EMAIL>>"
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, '').trim();
  const at = s.lastIndexOf('@');
  if (at < 1) return null;
  let local = s.slice(0, at).trim();
  let domain = s.slice(at + 1).trim();
  if (local.length > 1 && local.startsWith('"') && local.endsWith('"')) local = local.slice(1, -1);
  local = local.toLowerCase();
  domain = domain.replace(/\.+$/, '').toLowerCase();
  domain = domainToASCII(domain);
  if (!local || !domain || /\s/.test(local) || local.includes('@')) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) return null;
  if (domain === 'googlemail.com') domain = 'gmail.com';
  // Plus tags deliver to the same mailbox: suppress the mailbox, not the tag.
  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  if (!local) return null;
  return `${local}@${domain}`;
}

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return path.resolve(dir);
}

function fileFor(dir, key, type) {
  const h = createHash('sha256').update(key).digest('hex');
  return path.join(dir, `${h}.${type}`);
}

async function fsyncDir(dir) {
  let fh;
  try {
    fh = await fs.open(dir, 'r');
    await fh.sync();
  } catch {
    // Not supported on every platform; the file itself was already synced.
  } finally {
    await fh?.close();
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

export async function recordEvent({ email, type, now } = {}) {
  if (!TYPES.has(type)) throw new TypeError(`unknown event type: ${String(type)}`);
  const key = normalizeEmail(email);
  if (!key) throw new TypeError(`invalid email address: ${String(email)}`);
  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const final = fileFor(dir, key, type);
  const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : null;
  const tmp = path.join(dir, `.tmp-${process.pid}-${randomBytes(8).toString('hex')}`);
  try {
    // Write the whole file privately, then publish it atomically. link() fails
    // if the event is already recorded, so the first record wins and readers
    // never see a partial file. No locks are needed.
    const fh = await fs.open(tmp, 'wx');
    try {
      await fh.writeFile(JSON.stringify({ email: key, type, at }) + '\n');
      await fh.sync();
    } finally {
      await fh.close();
    }
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

export async function checkEmail({ email, kind, now } = {}) {
  if (!KINDS.has(kind)) return { allowed: false, rule: 'invalid-kind' };
  const key = normalizeEmail(email);
  if (!key) return { allowed: false, rule: 'invalid-address' };
  const dir = stateDir();
  for (const b of BLOCKS) {
    if (b.kinds.includes(kind) && (await exists(fileFor(dir, key, b.type)))) {
      return { allowed: false, rule: b.rule };
    }
  }
  return { allowed: true, rule: '' };
}
