// Shared send-rate limiter for follow-up messages.
//
// Every worker process points STATE_DIR at the same directory. Each lead has
// one JSON record in STATE_DIR/users, guarded by a lock directory in
// STATE_DIR/locks. A reservation is a send slot that is already claimed; it
// counts toward the limits until it is released.
//
// Limits (what the recipient experiences):
//   - window: at most maxPerWindow messages in any rolling windowHours span.
//     The window slides, so a slot frees as soon as its oldest send is older
//     than windowHours.
//   - gap: no message closer than minGapMinutes to another one, in either
//     direction in time.
// A reservation whose send the provider rejected is removed, so it no longer
// counts. A reservation whose outcome is unknown stays, since the lead may
// have received it.

import { mkdirSync, readFileSync, writeFileSync, renameSync, rmdirSync, statSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 15_000;

// Reads STATE_DIR on every call and creates it if missing.
function stateDir() {
  const raw = process.env.STATE_DIR;
  if (!raw) throw new Error('STATE_DIR is not set');
  const dir = resolve(raw);
  mkdirSync(join(dir, 'users'), { recursive: true });
  mkdirSync(join(dir, 'locks'), { recursive: true });
  return dir;
}

// Hex keeps any userId safe as a file name.
function keyOf(userId) {
  return Buffer.from(userId, 'utf8').toString('hex');
}

function validate(request, now) {
  if (request === null || typeof request !== 'object') throw new TypeError('request must be an object');
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request;
  if (typeof userId !== 'string' || userId.length === 0) throw new TypeError('userId must be a non-empty string');
  if (!Number.isInteger(maxPerWindow) || maxPerWindow < 0) throw new TypeError('maxPerWindow must be an integer >= 0');
  if (!Number.isFinite(windowHours) || windowHours <= 0) throw new TypeError('windowHours must be a number > 0');
  if (!Number.isFinite(minGapMinutes) || minGapMinutes < 0) throw new TypeError('minGapMinutes must be a number >= 0');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  return { userId, maxPerWindow, windowHours, minGapMinutes };
}

// Runs fn while holding the lock for one lead. A lock older than LOCK_STALE_MS
// is taken to belong to a crashed worker and is broken.
async function withLock(dir, key, fn) {
  const lockPath = join(dir, 'locks', `${key}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmdirSync(lockPath);
          continue;
        }
      } catch (statErr) {
        if (statErr.code !== 'ENOENT') throw statErr;
        continue;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for lock on ${key}`);
      await sleep(5 + Math.random() * 15);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      rmdirSync(lockPath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

function readRecord(dir, key) {
  try {
    return JSON.parse(readFileSync(join(dir, 'users', `${key}.json`), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { reservations: [], retainMs: 0 };
    throw err;
  }
}

// Temp file then rename, so a reader never sees a half-written record.
function writeRecord(dir, key, record) {
  const file = join(dir, 'users', `${key}.json`);
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(record));
  renameSync(tmp, file);
}

// Claims a send slot for one lead, or refuses with the limit that stopped it.
export async function reserve(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = validate(request, now);
  const at = now.getTime();
  const windowMs = windowHours * HOUR_MS;
  const gapMs = minGapMinutes * MINUTE_MS;
  const dir = stateDir();
  const key = keyOf(userId);

  return withLock(dir, key, () => {
    const record = readRecord(dir, key);

    // Keep records for the longest window seen for this lead, so a later call
    // with a longer window still sees the sends it needs.
    record.retainMs = Math.max(record.retainMs ?? 0, windowMs);
    record.reservations = record.reservations.filter((r) => at - r.at < record.retainMs);

    const sendsInWindow = record.reservations.filter((r) => at - r.at < windowMs).length;
    if (sendsInWindow >= maxPerWindow) {
      return { allowed: false, reason: 'window_limit', reservationId: null };
    }

    const tooClose = record.reservations.some((r) => Math.abs(at - r.at) < gapMs);
    if (tooClose) {
      return { allowed: false, reason: 'min_gap', reservationId: null };
    }

    // The key prefix lets release() find the record without a second index.
    const reservationId = `${key}.${randomUUID()}`;
    record.reservations.push({ id: reservationId, at });
    writeRecord(dir, key, record);
    return { allowed: true, reason: null, reservationId };
  });
}

// Gives back a slot the provider rejected. Unknown or already released ids
// are a no-op and return false.
export async function release(reservationId) {
  if (typeof reservationId !== 'string') return false;
  const dot = reservationId.indexOf('.');
  if (dot <= 0) return false;
  const key = reservationId.slice(0, dot);
  if (!/^[0-9a-f]+$/.test(key)) return false;

  const dir = stateDir();
  return withLock(dir, key, () => {
    const record = readRecord(dir, key);
    const before = record.reservations.length;
    record.reservations = record.reservations.filter((r) => r.id !== reservationId);
    if (record.reservations.length === before) return false;
    writeRecord(dir, key, record);
    return true;
  });
}
