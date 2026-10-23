// Suppression gate for outgoing email.
//
// State: one small marker file per (address, event type) in $STATE_DIR/suppression.
// A marker is written to a temp file, fsynced, then hard-linked to its final
// name. link() is atomic and fails if the name exists, so concurrent workers
// never see a partial file, never lose an update, and need no locks.
// Markers are never deleted: a suppression survives restarts of every process.
//
// Policy:
//   marketing     blocked by unsubscribe, spam_complaint, hard_bounce
//   transactional blocked only by hard_bounce (the address does not exist).
//                 Unsubscribes do not apply to transactional mail under CAN-SPAM;
//                 a spam complaint is treated as a marketing opt-out, and
//                 receipts / password resets the person asked for still go out.
//
// Address matching: the same mailbox may arrive as "Bob <Bob@Example.com>",
// " bob@example.com ", "mailto:...", with a trailing dot or Unicode domain,
// or with a +tag. Unsubscribes and complaints apply to every +tag variant of
// the address (and to dot/plus variants and googlemail.com at Gmail), because
// the person opted out, not one alias. Hard bounces apply to the exact
// mailbox (+tag included), since another alias may still exist.

import { createHash, randomBytes } from 'node:crypto';
import { domainToASCII } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';

const TYPES = new Set(['unsubscribe', 'spam_complaint', 'hard_bounce']);
const KINDS = new Set(['marketing', 'transactional']);

const RULES = {
  unsubscribe: 'unsubscribed',
  spam_complaint: 'spam_complaint',
  hard_bounce: 'hard_bounce',
};

function parseAddress(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.normalize('NFKC').trim();
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, '').trim();
  s = s.replace(/^"+|"+$/g, '').trim();
  if (!s || /[\s<>,;]/.test(s)) return null;
  const at = s.lastIndexOf('@');
  if (at < 1 || at === s.length - 1) return null;
  let local = s.slice(0, at).toLowerCase();
  let domain = s.slice(at + 1).toLowerCase().replace(/\.+$/, '');
  if (domain.startsWith('[')) return null;
  domain = domainToASCII(domain);
  if (!domain || !domain.includes('.')) return null;
  if (domain === 'googlemail.com') domain = 'gmail.com';

  let base = local;
  const plus = base.indexOf('+');
  if (plus > 0) base = base.slice(0, plus);
  if (domain === 'gmail.com') {
    base = base.replaceAll('.', '');
    local = base; // Gmail ignores dots and +tags: one mailbox
  }
  if (!base) return null;
  return { exact: `${local}@${domain}`, base: `${base}@${domain}` };
}

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return path.join(dir, 'suppression');
}

function markerPath(dir, type, key) {
  const h = createHash('sha256').update(key).digest('hex');
  return path.join(dir, `${type}.${h}.json`);
}

function keyFor(type, addr) {
  return type === 'hard_bounce' ? addr.exact : addr.base;
}

async function fsyncDir(dir) {
  let fh;
  try {
    fh = await fs.open(dir, 'r');
    await fh.sync();
  } catch {
    // directory fsync is not supported everywhere; the file itself is synced
  } finally {
    await fh?.close();
  }
}

export async function recordEvent({ email, type, now } = {}) {
  if (!TYPES.has(type)) throw new Error(`unknown event type: ${String(type)}`);
  const addr = parseAddress(email);
  if (!addr) throw new Error(`invalid email address: ${String(email)}`);
  const when = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();

  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const final = markerPath(dir, type, keyFor(type, addr));
  const tmp = path.join(dir, `.tmp-${process.pid}-${randomBytes(8).toString('hex')}`);
  const body = JSON.stringify({
    email: keyFor(type, addr),
    reported_as: String(email),
    type,
    recorded_at: when.toISOString(),
  });

  let fh;
  try {
    fh = await fs.open(tmp, 'wx', 0o600);
    await fh.writeFile(body);
    await fh.sync();
    await fh.close();
    fh = undefined;
    try {
      await fs.link(tmp, final);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err; // already recorded; keep first timestamp
    }
    await fsyncDir(dir);
  } finally {
    await fh?.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
    throw err;
  }
}

export async function checkEmail({ email, kind, now } = {}) {
  void now;
  if (!KINDS.has(kind)) return { allowed: false, rule: 'invalid_kind' };
  const addr = parseAddress(email);
  if (!addr) return { allowed: false, rule: 'invalid_address' };

  let dir;
  try {
    dir = stateDir();
  } catch {
    return { allowed: false, rule: 'state_unavailable' };
  }

  const blocking = kind === 'marketing'
    ? ['hard_bounce', 'spam_complaint', 'unsubscribe']
    : ['hard_bounce'];

  try {
    for (const type of blocking) {
      if (await exists(markerPath(dir, type, keyFor(type, addr)))) {
        return { allowed: false, rule: RULES[type] };
      }
    }
  } catch {
    // cannot read suppression state: fail closed rather than risk a bad send
    return { allowed: false, rule: 'state_unavailable' };
  }
  return { allowed: true, rule: '' };
}
