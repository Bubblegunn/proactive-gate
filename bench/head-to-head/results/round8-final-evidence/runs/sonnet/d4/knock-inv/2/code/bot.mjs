// Last-line send gate: suppression records shared between worker processes through STATE_DIR.
//
// Policy
//   unsubscribe     -> block marketing; transactional still allowed (CAN-SPAM covers commercial mail only)
//   spam_complaint  -> block marketing; transactional still allowed (receipts, password resets are needed)
//   hard_bounce     -> block everything (the address does not exist; sending again hurts reputation)
// Records are permanent. There is no re-subscribe path in this module.
//
// Storage
//   One empty-ish marker file per (address key, event type): <sha256(key)>.<type>
//   Each marker is written to a unique temp file, fsynced, then renamed into place.
//   rename() is atomic, so concurrent writers never need a lock and a reader never sees a partial file.
//   Writing the same event twice is harmless.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { domainToASCII } from 'node:url';

const EVENT_TYPES = new Set(['unsubscribe', 'spam_complaint', 'hard_bounce']);
const KINDS = new Set(['marketing', 'transactional']);

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

// Returns { exact, base } or null.
//   exact: the mailbox as precisely as we can say it (case, display name, IDN, gmail aliases folded).
//   base:  exact with the "+tag" removed. Used for opt-outs so that user+news@x also covers user@x.
function parseAddress(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw
    .normalize('NFKC')
    .replace(/[​-‍⁠﻿]/g, '')
    .trim();
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1].trim();
  if (/^mailto:/i.test(s)) s = s.slice(7).split('?')[0].trim();

  const at = s.lastIndexOf('@');
  if (at < 1) return null;

  let local = s.slice(0, at).toLowerCase();
  if (local.length > 2 && local.startsWith('"') && local.endsWith('"')) {
    const inner = local.slice(1, -1);
    if (/^[a-z0-9._%+-]+$/.test(inner)) local = inner;
  }
  if (!local || /[\s<>,;()]/.test(local)) return null;

  let domain = domainToASCII(s.slice(at + 1).trim().replace(/\.+$/, ''));
  if (!domain || !domain.includes('.')) return null;
  if (domain === 'googlemail.com') domain = 'gmail.com';

  if (domain === 'gmail.com') {
    // Gmail ignores dots and "+tag", so all of these are one mailbox.
    local = local.split('+')[0].replace(/\./g, '');
    if (!local) return null;
    const key = `${local}@${domain}`;
    return { exact: key, base: key };
  }
  const plus = local.indexOf('+');
  const baseLocal = plus > 0 ? local.slice(0, plus) : local;
  return { exact: `${local}@${domain}`, base: `${baseLocal}@${domain}` };
}

function markerPath(dir, key, type) {
  const hash = createHash('sha256').update(key).digest('hex');
  return path.join(dir, `${hash}.${type}`);
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
    throw err; // unreadable state must not read as "not suppressed"
  }
}

async function fsyncDir(dir) {
  let handle;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch (err) {
    if (!['EISDIR', 'EPERM', 'EINVAL', 'EACCES'].includes(err.code)) throw err;
  } finally {
    await handle?.close();
  }
}

async function writeMarker(dir, file, content) {
  const tmp = path.join(dir, `.tmp-${process.pid}-${randomBytes(8).toString('hex')}`);
  let handle;
  try {
    handle = await open(tmp, 'wx');
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tmp, file);
  } catch (err) {
    await handle?.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw err;
  }
  await fsyncDir(dir);
}

export async function recordEvent({ email, type, now } = {}) {
  if (!EVENT_TYPES.has(type)) throw new TypeError(`unknown event type: ${String(type)}`);
  if (typeof email !== 'string') throw new TypeError('email must be a string');
  const dir = stateDir();

  // Never lose an opt-out because the address looks odd: fall back to the raw text.
  const parsed = parseAddress(email);
  const fallback = `raw:${email.normalize('NFKC').trim().toLowerCase()}`;
  const key = type === 'hard_bounce' ? (parsed?.exact ?? fallback) : (parsed?.base ?? fallback);

  const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : null;
  await mkdir(dir, { recursive: true });
  await writeMarker(dir, markerPath(dir, key, type), JSON.stringify({ key, type, at, raw: email }) + '\n');
}

export async function checkEmail({ email, kind, now } = {}) {
  if (!KINDS.has(kind)) return { allowed: false, rule: 'invalid_kind' };
  const parsed = parseAddress(email);
  if (!parsed) return { allowed: false, rule: 'invalid_address' };
  const dir = stateDir();

  if (await exists(markerPath(dir, parsed.exact, 'hard_bounce'))) {
    return { allowed: false, rule: 'hard_bounce' };
  }
  if (kind === 'marketing') {
    if (await exists(markerPath(dir, parsed.base, 'spam_complaint'))) {
      return { allowed: false, rule: 'spam_complaint' };
    }
    if (await exists(markerPath(dir, parsed.base, 'unsubscribe'))) {
      return { allowed: false, rule: 'unsubscribed' };
    }
  }
  return { allowed: true, rule: '' };
}
