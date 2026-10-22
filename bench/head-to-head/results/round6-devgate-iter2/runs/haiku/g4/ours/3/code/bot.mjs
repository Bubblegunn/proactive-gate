// Shared send-rate limiter for outbound lead messages.
// Every worker process calls reserve() before sending and release() if the
// provider rejects the message. State lives in STATE_DIR, one ledger file per
// lead, guarded by a per-lead lock file so concurrent workers cannot both win.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const MAX_WINDOW_HOURS = 90 * 24; // ledger retention is 90 days, so windows must fit inside it
const RETENTION_MS = MAX_WINDOW_HOURS * HOUR_MS;
const LOCK_STALE_MS = 10_000; // a lock held longer than this belongs to a crashed worker
const LOCK_RETRY_MS = 15;
const LOCK_TIMEOUT_MS = 5_000;

// Reserve a send slot for one lead.
// Counts: every reservation that was not released, including ones whose send
// outcome is unknown, because the recipient may already have the message.
// Window: rolling, (now - windowHours, now]. Reservations stamped in the
// future by a skewed worker clock still count (conservative).
// Gap: the newest counted reservation must be at least minGapMinutes before now.
export async function reserve(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = validate(request, now);
  const dir = stateDir();
  const key = keyFor(userId);
  const file = ledgerFile(dir, key);
  await mkdir(path.dirname(file), { recursive: true });

  return withLock(dir, key, async () => {
    const t = now.getTime();
    const ledger = await readLedger(file, userId);
    ledger.reservations = ledger.reservations.filter((r) => r.at > t - RETENTION_MS);
    const active = ledger.reservations.filter((r) => !r.released);

    const windowStart = t - windowHours * HOUR_MS;
    const inWindow = active.filter((r) => r.at > windowStart).length;
    if (inWindow >= maxPerWindow) {
      await writeLedger(file, ledger);
      return { allowed: false, reason: 'window_limit_reached', reservationId: null };
    }

    const newest = active.reduce((max, r) => Math.max(max, r.at), -Infinity);
    if (newest > t - minGapMinutes * MINUTE_MS) {
      await writeLedger(file, ledger);
      return { allowed: false, reason: 'min_gap_not_elapsed', reservationId: null };
    }

    const reservationId = `${key}.${randomUUID()}`;
    ledger.reservations.push({ id: reservationId, at: t, released: false });
    await writeLedger(file, ledger);
    return { allowed: true, reason: null, reservationId };
  });
}

// Give back a slot whose message the provider rejected. Safe to call from any
// process. Returns true if a slot was freed, false if the id is unknown,
// already released, or aged out of retention.
export async function release(reservationId) {
  if (typeof reservationId !== 'string') return false;
  const dot = reservationId.indexOf('.');
  const key = reservationId.slice(0, dot);
  if (dot !== 64 || !/^[0-9a-f]{64}$/.test(key)) return false;

  const dir = stateDir();
  const file = ledgerFile(dir, key);
  return withLock(dir, key, async () => {
    const ledger = await readLedger(file, null);
    const record = ledger.reservations.find((r) => r.id === reservationId);
    if (!record || record.released) return false;
    record.released = true;
    await writeLedger(file, ledger);
    return true;
  });
}

// ---- helpers ----

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set; every worker must point at the same directory');
  return dir;
}

function keyFor(userId) {
  return createHash('sha256').update(userId).digest('hex');
}

function ledgerFile(dir, key) {
  return path.join(dir, 'rate-limit', 'ledgers', `${key}.json`);
}

function validate(request, now) {
  if (!request || typeof request !== 'object') throw new TypeError('request must be an object');
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request;
  if (typeof userId !== 'string' || userId === '') throw new TypeError('userId must be a non-empty string');
  if (!Number.isInteger(maxPerWindow) || maxPerWindow < 0) throw new TypeError('maxPerWindow must be an integer >= 0');
  if (typeof windowHours !== 'number' || !(windowHours > 0 && windowHours <= MAX_WINDOW_HOURS)) {
    throw new TypeError(`windowHours must be > 0 and <= ${MAX_WINDOW_HOURS}`);
  }
  if (typeof minGapMinutes !== 'number' || !(minGapMinutes >= 0)) throw new TypeError('minGapMinutes must be >= 0');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  return { userId, maxPerWindow, windowHours, minGapMinutes };
}

async function readLedger(file, userId) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { userId, reservations: [] };
    throw err; // corrupt or unreadable ledger: fail closed, do not guess
  }
}

// Write to a temp file in the same directory, then rename over the target.
// rename is atomic on one filesystem, so readers never see a half-written file.
async function writeLedger(file, ledger) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(ledger));
  await rename(tmp, file);
}

async function withLock(dir, key, fn) {
  const lock = path.join(dir, 'rate-limit', 'locks', `${key}.lock`);
  await mkdir(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      (await open(lock, 'wx')).close();
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      await breakIfStale(lock);
      if (Date.now() > deadline) throw new Error(`timed out waiting for rate-limit lock ${key}`);
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lock).catch(() => {});
  }
}

// Only one worker can rename the stale lock away; the others get ENOENT.
async function breakIfStale(lock) {
  try {
    const { mtimeMs } = await stat(lock);
    if (Date.now() - mtimeMs > LOCK_STALE_MS) {
      const grave = `${lock}.${randomUUID()}.stale`;
      await rename(lock, grave);
      await unlink(grave).catch(() => {});
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}
