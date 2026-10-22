// Email send gate for the shop's agent: unsubscribe/resubscribe state and mayEmail().
//
// All state lives in STATE_DIR/suppression.jsonl. It is append-only: one JSON record per line,
// written with O_APPEND and fsynced. Every worker on the machine appends to and reads the same
// file, so state survives restarts and every worker sees the same events.
import { open, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { domainToASCII } from 'node:url';

const LOG_NAME = 'suppression.jsonl';

// Per-process read cache, keyed by state directory.
// offset: bytes of the log already applied.
// states: normalized address -> { unsubAt, resubAt } (epoch ms, -Infinity when never recorded).
const caches = new Map();

// Serializes reads within this process so two calls never apply the same bytes twice.
let queue = Promise.resolve();

function serialized(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function cacheFor(dir) {
  let cache = caches.get(dir);
  if (!cache) {
    cache = { offset: 0, states: new Map() };
    caches.set(dir, cache);
  }
  return cache;
}

// Maps an address to the key of the person behind it. Errs toward matching more addresses,
// because a missed opt-out is worse than an over-matched one.
// - accepts "Name <addr>" and "mailto:addr" forms from headers
// - lowercases, converts IDN domains to ASCII
// - googlemail.com is the same mailbox as gmail.com; Gmail ignores dots in the local part
// - strips "+tag" aliases on every domain
export function normalizeAddress(input) {
  if (typeof input !== 'string') throw new TypeError('email must be a string');
  let s = input.trim();
  const angle = s.match(/<([^<>]+)>\s*$/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, '');
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) throw new TypeError(`invalid email address: ${input}`);
  let local = s.slice(0, at).toLowerCase().split('+')[0];
  let domain = domainToASCII(s.slice(at + 1).toLowerCase().replace(/\.$/, ''));
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  if (!local || /[\s@]/.test(local) || !domain.includes('.') || /\s/.test(domain)) {
    throw new TypeError(`invalid email address: ${input}`);
  }
  return `${local}@${domain}`;
}

// Applies one log line. Torn or malformed lines are skipped.
// Each event only moves its field forward (max), so out-of-order or duplicate events are harmless.
function applyLine(cache, line) {
  if (!line.trim()) return;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return;
  }
  if (!rec || typeof rec.email !== 'string' || !Number.isFinite(rec.at)) return;
  if (rec.type !== 'unsubscribe' && rec.type !== 'resubscribe') return;
  const s = cache.states.get(rec.email) ?? { unsubAt: -Infinity, resubAt: -Infinity };
  if (rec.type === 'unsubscribe') s.unsubAt = Math.max(s.unsubAt, rec.at);
  else s.resubAt = Math.max(s.resubAt, rec.at);
  cache.states.set(rec.email, s);
}

// Reads only the bytes appended since the last refresh, and only up to the last newline,
// so a line another worker is still writing is picked up on a later call.
async function refresh(dir, cache) {
  let fh;
  try {
    fh = await open(join(dir, LOG_NAME), 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  try {
    const { size } = await fh.stat();
    if (size < cache.offset) {
      // The log was replaced or truncated. Rebuild from scratch.
      cache.offset = 0;
      cache.states.clear();
    }
    if (size === cache.offset) return;
    const buf = Buffer.alloc(size - cache.offset);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, cache.offset + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    const end = buf.subarray(0, got).lastIndexOf(0x0a);
    if (end < 0) return;
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) applyLine(cache, line);
    cache.offset += end + 1;
  } finally {
    await fh.close();
  }
}

async function append(dir, record) {
  await mkdir(dir, { recursive: true });
  const fh = await open(join(dir, LOG_NAME), 'a');
  try {
    // The leading newline ends any torn line a crashed writer left behind.
    await fh.writeFile(`\n${JSON.stringify(record)}\n`);
    await fh.datasync();
  } finally {
    await fh.close();
  }
}

async function record(type, email, at) {
  const key = normalizeAddress(email);
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) {
    throw new TypeError('at must be a valid Date');
  }
  await append(stateDir(), {
    type,
    email: key,
    at: at.getTime(),
    recordedAt: new Date().toISOString(),
  });
}

// Marketing opt-out. Applies to marketing mail only; the person still gets receipts and password resets.
export async function recordUnsubscribe(email, at) {
  await record('unsubscribe', email, at);
}

// Explicit opt-in only (signup form, checkbox). Purchases and logins do not count.
// It overrides an unsubscribe only when its `at` is strictly later.
export async function recordResubscribe(email, at) {
  await record('resubscribe', email, at);
}

function deny(reason) {
  return { allowed: false, reason };
}

// Called before each queued email leaves. Unknown kinds and bad recipients are denied, not thrown,
// so the queue can record the reason and move on. A missing STATE_DIR throws, so the queue never
// sends blind.
export async function mayEmail(message, now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  const kind = message?.kind;
  if (kind !== 'marketing' && kind !== 'transactional') return deny('unknown_kind');
  let key;
  try {
    key = normalizeAddress(message.to);
  } catch {
    return deny('invalid_recipient');
  }
  // Receipts and password resets are not gated by marketing opt-outs.
  if (kind === 'transactional') return { allowed: true, reason: null };

  const dir = stateDir();
  const state = await serialized(async () => {
    const cache = cacheFor(dir);
    await refresh(dir, cache);
    return cache.states.get(key);
  });
  // Opted out unless a resubscribe is strictly later than the latest unsubscribe.
  // Ties count as opted out.
  if (state && state.unsubAt !== -Infinity && state.resubAt <= state.unsubAt) {
    return deny('marketing_unsubscribed');
  }
  return { allowed: true, reason: null };
}
