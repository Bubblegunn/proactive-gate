// Opt-out gate for marketing and AI-drafted email.
// State lives in STATE_DIR/optout as one append-only JSON-lines file per address,
// so every worker process and every restart sees the same events.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const KINDS = new Set(['marketing', 'transactional']);

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function isValidDate(d) {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

// Accepts "<EMAIL>" or 'Name <<EMAIL>>' and returns one key per person.
// Gmail ignores dots and +tags, so those variants map to the same key.
function canonicalEmail(input) {
  if (typeof input !== 'string') return null;
  const angle = input.match(/<([^<>]+)>/);
  const addr = (angle ? angle[1] : input).trim().replace(/^"+|"+$/g, '').trim().toLowerCase();
  if (!addr || /\s/.test(addr)) return null;
  const at = addr.lastIndexOf('@');
  if (at <= 0 || at === addr.length - 1) return null;
  let local = addr.slice(0, at);
  let domain = addr.slice(at + 1);
  if (!/^[^@]+\.[^@]+$/.test(domain)) return null;
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.split('+')[0].replace(/\./g, '');
  if (!local) return null;
  return `${local}@${domain}`;
}

function logPath(dir, key) {
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return path.join(dir, 'optout', `${hash}.jsonl`);
}

// Latest unsubscribe and latest resubscribe, by event time (not arrival order).
async function readState(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { unsubAt: null, resubAt: null };
    throw err;
  }
  let unsubAt = null;
  let resubAt = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // torn line from a crash mid-write
    }
    if (!ev || typeof ev !== 'object') continue;
    const t = Date.parse(ev.at);
    if (Number.isNaN(t)) continue;
    if (ev.type === 'unsubscribe' && (unsubAt === null || t > unsubAt)) unsubAt = t;
    if (ev.type === 'resubscribe' && (resubAt === null || t > resubAt)) resubAt = t;
  }
  return { unsubAt, resubAt };
}

// A tie goes to opt-out: an unsubscribe is never lost to a same-millisecond resubscribe.
function isOptedOut({ unsubAt, resubAt }) {
  return unsubAt !== null && (resubAt === null || unsubAt >= resubAt);
}

async function record(type, email, at) {
  const dir = stateDir();
  const key = canonicalEmail(email);
  if (!key) throw new TypeError(`not an email address: ${String(email)}`);
  if (!isValidDate(at)) throw new TypeError('at must be a valid Date');
  await fs.mkdir(path.join(dir, 'optout'), { recursive: true });
  const line = JSON.stringify({
    type,
    key,
    at: at.toISOString(),
    written: new Date().toISOString(),
  }) + '\n';
  // O_APPEND: one line per write, safe across worker processes.
  const fh = await fs.open(logPath(dir, key), 'a');
  try {
    await fh.write(line);
    await fh.datasync();
  } finally {
    await fh.close();
  }
}

export function recordUnsubscribe(email, at) {
  return record('unsubscribe', email, at);
}

export function recordResubscribe(email, at) {
  return record('resubscribe', email, at);
}

export async function mayEmail(message, now) {
  const dir = stateDir();
  await fs.mkdir(path.join(dir, 'optout'), { recursive: true });
  if (!isValidDate(now)) return { allowed: false, reason: 'invalid_time' };
  const kind = message?.kind;
  if (!KINDS.has(kind)) return { allowed: false, reason: 'unknown_kind' };
  const key = canonicalEmail(message?.to);
  if (!key) return { allowed: false, reason: 'invalid_recipient' };
  // Receipts and password resets are not marketing, so an opt-out does not stop them.
  if (kind === 'transactional') return { allowed: true, reason: null };
  if (isOptedOut(await readState(logPath(dir, key)))) {
    return { allowed: false, reason: 'unsubscribed' };
  }
  return { allowed: true, reason: null };
}
