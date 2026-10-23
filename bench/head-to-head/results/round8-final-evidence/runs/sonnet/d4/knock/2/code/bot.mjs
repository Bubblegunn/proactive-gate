import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';
import path from 'node:path';

const TYPES = new Set(['unsubscribe', 'spam_complaint', 'hard_bounce']);
const KINDS = new Set(['marketing', 'transactional']);

// Reduce the many spellings of one mailbox to one canonical key.
// Returns null when the input is not a usable address.
function canonicalize(input) {
  if (typeof input !== 'string') return null;
  let s = input.normalize('NFKC').trim();
  // "Name <<EMAIL>>" -> <EMAIL>
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, '').trim();
  s = s.replace(/^["'<]+|[>"']+$/g, '').trim();
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) return null;
  let local = s.slice(0, at).toLowerCase();
  let domain = s.slice(at + 1).toLowerCase().replace(/\.+$/, '');
  if (/[\s<>,;()]/.test(local) || /[\s<>,;()@]/.test(domain)) return null;
  domain = domainToASCII(domain);
  if (!domain || !domain.includes('.')) return null;
  if (domain === 'googlemail.com') domain = 'gmail.com';
  // Plus-tags never change the mailbox; suppress them together.
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  if (!local) return null;
  return `${local}@${domain}`;
}

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function fileFor(dir, key, type) {
  const h = createHash('sha256').update(key).digest('hex');
  return path.join(dir, `${type}.${h}.json`);
}

async function fsyncDir(dir) {
  let fh;
  try {
    fh = await fs.open(dir, 'r');
    await fh.sync();
  } catch {
    // directory fsync is not supported everywhere
  } finally {
    await fh?.close();
  }
}

export async function recordEvent({ email, type, now } = {}) {
  if (!TYPES.has(type)) throw new Error(`unknown event type: ${type}`);
  const key = canonicalize(email);
  if (!key) throw new Error(`invalid email address: ${email}`);
  const when = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const target = fileFor(dir, key, type);
  try {
    await fs.access(target);
    return; // already recorded; keep the first record
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const tmp = path.join(dir, `.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`);
  const fh = await fs.open(tmp, 'wx');
  try {
    await fh.writeFile(JSON.stringify({ email: key, type, at: when.toISOString() }));
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    // link fails if another worker already wrote it, so the first record wins
    await fs.link(tmp, target);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
  await fsyncDir(dir);
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

export async function checkEmail({ email, kind, now } = {}) {
  if (!KINDS.has(kind)) return { allowed: false, rule: 'invalid_kind' };
  const key = canonicalize(email);
  if (!key) return { allowed: false, rule: 'invalid_address' };
  try {
    const dir = stateDir();
    // A nonexistent address hurts reputation whatever the mail is.
    if (await exists(fileFor(dir, key, 'hard_bounce'))) {
      return { allowed: false, rule: 'hard_bounce' };
    }
    if (kind === 'marketing') {
      if (await exists(fileFor(dir, key, 'unsubscribe'))) {
        return { allowed: false, rule: 'unsubscribed' };
      }
      if (await exists(fileFor(dir, key, 'spam_complaint'))) {
        return { allowed: false, rule: 'spam_complaint' };
      }
    }
  } catch {
    return { allowed: false, rule: 'state_unavailable' };
  }
  return { allowed: true, rule: '' };
}
