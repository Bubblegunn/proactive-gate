// Last-line send gate: records unsubscribe / spam complaint / hard bounce events
// and decides whether a message may go out.
//
// State: one marker file per (event type, normalized address) in STATE_DIR.
// A marker is written to a temp file, fsynced, then hard-linked to its final
// name. link() fails with EEXIST if another worker already recorded the same
// event, so concurrent writers need no lock and a marker is never half-written.

import { createHash, randomBytes } from 'node:crypto';
import { domainToASCII } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';

const EVENT_TYPES = new Set(['unsubscribe', 'spam_complaint', 'hard_bounce']);
const KINDS = new Set(['marketing', 'transactional']);
const GMAIL = new Set(['gmail.com', 'googlemail.com']);

// Returns { exact, base } or null when the address cannot be parsed.
//  exact: the mailbox as far as we can tell (used for bounces, which are
//         specific to one mailbox).
//  base:  exact with any "+tag" removed (used for opt-outs and complaints, so a
//         person cannot be mailed again through a tagged variant).
function normalize(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.normalize('NFKC').trim();
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, '').trim();
  s = s.replace(/^"(.*)"(?=@)/, '$1');
  const at = s.lastIndexOf('@');
  if (at < 1) return null;
  let local = s.slice(0, at).toLowerCase();
  let domain = s.slice(at + 1).toLowerCase().replace(/\.+$/, '');
  if (!local || !domain || /[\s<>,;:"()\\\u0000-\u001f]/.test(local)) return null;
  domain = domainToASCII(domain);
  if (!domain || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return null;

  let base = local.split('+')[0];
  if (!base) return null;
  if (GMAIL.has(domain)) {
    domain = 'gmail.com';
    base = base.replace(/\./g, '');
    if (!base) return null;
    return { exact: `${base}@${domain}`, base: `${base}@${domain}` };
  }
  return { exact: `${local}@${domain}`, base: `${base}@${domain}` };
}

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function markerName(type, key) {
  return `${type}-${createHash('sha256').update(key).digest('hex')}`;
}

async function exists(dir, name) {
  try {
    await fs.access(path.join(dir, name));
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
    // Directory fsync is not supported everywhere; the file itself is synced.
  } finally {
    await fh?.close();
  }
}

async function writeMarker(dir, name, payload) {
  const final = path.join(dir, name);
  const tmp = path.join(dir, `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  const fh = await fs.open(tmp, 'wx');
  try {
    await fh.writeFile(JSON.stringify(payload));
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.link(tmp, final);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err; // already recorded: keep the first one
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
  await fsyncDir(dir);
}

export async function recordEvent({ email, type, now } = {}) {
  if (!EVENT_TYPES.has(type)) throw new Error(`unknown event type: ${String(type)}`);
  const addr = normalize(email);
  if (!addr) throw new Error(`invalid email address: ${String(email)}`);
  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const key = type === 'hard_bounce' ? addr.exact : addr.base;
  const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now.toISOString() : null;
  await writeMarker(dir, markerName(type, key), { type, email: key, at });
}

export async function checkEmail({ email, kind, now } = {}) {
  if (!KINDS.has(kind)) return { allowed: false, rule: 'invalid_kind' };
  const addr = normalize(email);
  if (!addr) return { allowed: false, rule: 'invalid_address' };
  try {
    const dir = stateDir();
    // A mailbox that does not exist is never mailed, whatever the kind.
    if (await exists(dir, markerName('hard_bounce', addr.exact))) {
      return { allowed: false, rule: 'hard_bounce' };
    }
    // Opt-outs and complaints stop marketing only; receipts, password resets
    // and similar mail the person needs still go out.
    if (kind === 'marketing') {
      if (await exists(dir, markerName('spam_complaint', addr.base))) {
        return { allowed: false, rule: 'spam_complaint' };
      }
      if (await exists(dir, markerName('unsubscribe', addr.base))) {
        return { allowed: false, rule: 'unsubscribed' };
      }
    }
    return { allowed: true, rule: '' };
  } catch {
    // Cannot read state: fail closed rather than risk mailing a suppressed address.
    return { allowed: false, rule: 'state_unavailable' };
  }
}
