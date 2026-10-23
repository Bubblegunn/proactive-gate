import { promises as fs } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { domainToASCII } from 'node:url';
import path from 'node:path';

const TYPES = new Set(['unsubscribe', 'spam_complaint', 'hard_bounce']);
const KINDS = new Set(['marketing', 'transactional']);

// Returns the canonical address, or null when the input is not a usable address.
function normalize(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.normalize('NFKC').trim();
  s = s.replace(/^mailto:/i, '');
  const angle = s.match(/<([^<>]*)>\s*$/); // "Name <<EMAIL>>"
  if (angle) s = angle[1];
  s = s.replace(/^["'\s]+|["'\s]+$/g, '').replace(/[\u200b-\u200d\ufeff]/g, '');
  const at = s.lastIndexOf('@');
  if (at < 1 || at === s.length - 1) return null;
  const local = s.slice(0, at).toLowerCase();
  let domain = domainToASCII(s.slice(at + 1).toLowerCase().replace(/\.$/, ''));
  if (!domain || !domain.includes('.') || /[\s<>,;()"\\]/.test(local + domain)) return null;
  if (/\s/.test(local)) return null;
  return `${local}@${domain}`;
}

function dirOf() {
  const d = process.env.STATE_DIR;
  if (!d) throw new Error('STATE_DIR is not set');
  return d;
}

function fileFor(dir, addr, type) {
  const h = createHash('sha256').update(addr).digest('hex');
  return path.join(dir, `${type}-${h}.json`);
}

async function exists(f) {
  try { await fs.access(f); return true; } catch { return false; }
}

export async function recordEvent({ email, type, now } = {}) {
  if (!TYPES.has(type)) throw new Error(`unknown event type: ${type}`);
  const addr = normalize(email);
  if (!addr) throw new Error('invalid email address');
  const dir = dirOf();
  await fs.mkdir(dir, { recursive: true });
  const final = fileFor(dir, addr, type);
  const tmp = path.join(dir, `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  const at = now instanceof Date && !isNaN(now) ? now.toISOString() : null;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify({ email: addr, type, recordedAt: at }));
    await fh.sync();
  } finally { await fh.close(); }
  try {
    await fs.link(tmp, final); // atomic; first writer wins, repeats are no-ops
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

export async function checkEmail({ email, kind, now } = {}) {
  if (!KINDS.has(kind)) return { allowed: false, rule: 'unknown-kind' };
  const addr = normalize(email);
  if (!addr) return { allowed: false, rule: 'invalid-address' };
  const dir = dirOf();
  if (await exists(fileFor(dir, addr, 'hard_bounce'))) return { allowed: false, rule: 'hard-bounce' };
  if (kind === 'marketing') {
    if (await exists(fileFor(dir, addr, 'spam_complaint'))) return { allowed: false, rule: 'spam-complaint' };
    if (await exists(fileFor(dir, addr, 'unsubscribe'))) return { allowed: false, rule: 'unsubscribed' };
  }
  return { allowed: true, rule: '' };
}
