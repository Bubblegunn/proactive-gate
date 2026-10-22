// Shared send rate limiter for lead follow-ups.
//
// State lives in STATE_DIR (read on every call), one JSON file per lead:
//   <STATE_DIR>/reservations/<key>.json   history of send slots for one lead
//   <STATE_DIR>/locks/<key>.lock          exclusive lock held during read-modify-write
//
// A reservation counts toward the limits while its status is "held".
// A released reservation (provider rejected the send) stops counting.
// Reservation ids look like "<key>.<uuid>" so release() can find the lead file.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const LOCK_STALE_MS = 30 * 1000; // a lock older than this came from a crashed worker
const LOCK_WAIT_MS = 10 * 1000;  // give up waiting after this and throw (fail closed, no send)

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function keyFor(userId) {
  return Buffer.from(userId, 'utf8').toString('base64url');
}

function validate(request, now) {
  if (!request || typeof request !== 'object') throw new TypeError('request must be an object');
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request;
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new TypeError('userId must be a non-empty string');
  }
  if (!Number.isInteger(maxPerWindow) || maxPerWindow < 0) {
    throw new TypeError('maxPerWindow must be a non-negative integer');
  }
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    throw new TypeError('windowHours must be a positive number');
  }
  if (!Number.isFinite(minGapMinutes) || minGapMinutes < 0) {
    throw new TypeError('minGapMinutes must be a non-negative number');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
}

async function ensureDirs(root) {
  await fs.mkdir(path.join(root, 'reservations'), { recursive: true });
  await fs.mkdir(path.join(root, 'locks'), { recursive: true });
}

// Exclusive lock via O_EXCL create. Works across processes on one machine.
async function withLock(root, key, fn) {
  const lockPath = path.join(root, 'locks', `${key}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.close();
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const st = await fs.stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch (statErr) {
        if (statErr.code !== 'ENOENT') throw statErr;
        continue; // holder just released it; retry at once
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for lock on lead ${key}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 15));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lockPath, { force: true });
  }
}

async function readHistory(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  // A corrupt file throws instead of resetting: resetting would forget sends and allow over-sending.
  return JSON.parse(text);
}

// Temp file then rename, so a crash never leaves a half-written history.
async function writeHistory(file, history) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(history));
  await fs.rename(tmp, file);
}

/**
 * Claim a send slot for one lead.
 * Limits (sliding window, measured from `now`):
 *   - window_limit_reached: maxPerWindow held sends already in the last windowHours.
 *   - min_gap_not_elapsed: a held send is less than minGapMinutes away from `now`, in either
 *     direction (a future-dated entry from a skewed clock also blocks).
 */
export async function reserve(request, now) {
  validate(request, now);
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request;
  const root = stateDir();
  await ensureDirs(root);

  const key = keyFor(userId);
  const file = path.join(root, 'reservations', `${key}.json`);
  const nowMs = now.getTime();
  const windowMs = windowHours * HOUR_MS;
  const gapMs = minGapMinutes * MINUTE_MS;

  return withLock(root, key, async () => {
    const history = await readHistory(file);
    const held = history.filter((r) => r.status === 'held');

    const sentInWindow = held.filter((r) => r.at > nowMs - windowMs).length;
    if (sentInWindow >= maxPerWindow) {
      return { allowed: false, reason: 'window_limit_reached', reservationId: null };
    }
    if (gapMs > 0 && held.some((r) => Math.abs(nowMs - r.at) < gapMs)) {
      return { allowed: false, reason: 'min_gap_not_elapsed', reservationId: null };
    }

    const reservationId = `${key}.${randomUUID()}`;
    history.push({ id: reservationId, at: nowMs, status: 'held' });
    await writeHistory(file, history);
    return { allowed: true, reason: null, reservationId };
  });
}

/**
 * Give back a slot after the provider rejected the message.
 * Safe to call from any process. Idempotent: releasing twice or releasing an unknown id does nothing.
 */
export async function release(reservationId) {
  if (typeof reservationId !== 'string') return { released: false };
  const dot = reservationId.indexOf('.');
  const key = dot > 0 ? reservationId.slice(0, dot) : '';
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return { released: false };

  const root = stateDir();
  await ensureDirs(root);
  const file = path.join(root, 'reservations', `${key}.json`);

  return withLock(root, key, async () => {
    const history = await readHistory(file);
    const entry = history.find((r) => r.id === reservationId);
    if (!entry || entry.status !== 'held') return { released: false };
    entry.status = 'released';
    await writeHistory(file, history);
    return { released: true };
  });
}
