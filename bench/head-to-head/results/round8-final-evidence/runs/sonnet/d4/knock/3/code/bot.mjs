// Suppression gate for outgoing email.
//
// State layout: one empty-ish marker file per (normalized address, event type)
// in STATE_DIR, named "<sha256(address)>.<type>". A marker is written to a
// temporary file, fsynced, then hard-linked to its final name, so a reader
// never sees a partial marker, two writers racing on the same marker are safe
// (the first one wins, the other gets EEXIST), and no lock is needed.
//
// Policy:
//   unsubscribe     -> block marketing (CAN-SPAM); transactional still allowed
//   spam_complaint  -> block marketing; transactional still allowed
//   hard_bounce     -> block everything (the mailbox does not exist)
// Suppressions are permanent: nothing here removes them.

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { domainToASCII } from 'node:url';

const TYPES = new Set(['unsubscribe', 'spam_complaint', 'hard_bounce']);
const KINDS = new Set(['marketing', 'transactional']);

// Checked in this order; first hit supplies the rule identifier.
const RULES = [
  { type: 'hard_bounce', rule: 'hard_bounce', kinds: ['marketing', 'transactional'] },
  { type: 'spam_complaint', rule: 'spam_complaint', kinds: ['marketing'] },
  { type: 'unsubscribe', rule: 'unsubscribed', kinds: ['marketing'] },
];

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

// Returns the canonical form of an address, or null if it is not a usable address.
// Folding is deliberately aggressive, because a missed match means mailing someone
// who opted out: case, surrounding whitespace, "Name <a@b>", "mailto:", quotes,
// trailing dot and IDN form of the domain, "+tag" suffixes, and dots in Gmail names.
export function normalizeEmail(input) {
  if (typeof input !== 'string') return null;
  let s = input.normalize('NFKC').trim();
  if (/^mailto:/i.test(s)) {
    s = s.slice(7).trim();
    const q = s.indexOf('?');
    if (q !== -1) s = s.slice(0, q); // mailto:a@b?subject=...
  }
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^<|>$/g, '').trim();
  const at = s.lastIndexOf('@');
  if (at < 1) return null;
  let local = s.slice(0, at).trim();
  let domain = s.slice(at + 1).trim();
  if (local.length >= 2 && local.startsWith('"') && local.endsWith('"')) {
    local = local.slice(1, -1);
  }
  local = local.toLowerCase();
  domain = domainToASCII(domain.replace(/\.+$/, '').toLowerCase());
  if (!local || !domain) return null;
  if (/[\s<>,;:"()[\]\\]/.test(local)) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(domain)) return null;
  if (domain.startsWith('-') || domain.includes('.-') || domain.includes('-.')) return null;
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  if (!local) return null;
  return `${local}@${domain}`;
}

function markerPath(dir, address, type) {
  const h = createHash('sha256').update(address).digest('hex');
  return path.join(dir, `${h}.${type}`);
}

async function fsyncDir(dir) {
  let fh;
  try {
    fh = await fs.open(dir, 'r');
    await fh.sync();
  } catch {
    // Directory fsync is not supported everywhere; the file itself is already synced.
  } finally {
    await fh?.close();
  }
}

export async function recordEvent({ email, type, now } = {}) {
  if (!TYPES.has(type)) throw new Error(`unknown event type: ${String(type)}`);
  const address = normalizeEmail(email);
  if (!address) throw new Error(`invalid email address: ${String(email)}`);
  const when = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();

  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const final = markerPath(dir, address, type);
  const tmp = path.join(dir, `.tmp-${process.pid}-${randomBytes(8).toString('hex')}`);
  const body = JSON.stringify({ address, type, at: when.toISOString() }) + '\n';

  const fh = await fs.open(tmp, 'wx', 0o644);
  try {
    await fh.writeFile(body);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.link(tmp, final); // fails if another worker already recorded it: keep the first
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
  await fsyncDir(dir);
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
    throw err; // cannot read state: do not guess, let the worker see the failure
  }
}

export async function checkEmail({ email, kind, now } = {}) {
  if (!KINDS.has(kind)) return { allowed: false, rule: 'invalid_kind' };
  const address = normalizeEmail(email);
  if (!address) return { allowed: false, rule: 'invalid_address' };

  const dir = stateDir();
  for (const { type, rule, kinds } of RULES) {
    if (!kinds.includes(kind)) continue;
    if (await exists(markerPath(dir, address, type))) return { allowed: false, rule };
  }
  return { allowed: true, rule: '' };
}
