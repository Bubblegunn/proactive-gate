// Shared send rate limiter for proactive lead follow-ups.
//
// Every worker on this machine points STATE_DIR at the same directory, so the
// history is shared across processes and survives restarts.
//
//   STATE_DIR/leads/<sha256(userId)>.json   reservation history for one lead
//   STATE_DIR/locks/<sha256(userId)>.lock/  mkdir-based lock for that lead
//
// What counts toward the limits (from the recipient's point of view):
// - A reservation counts from the moment it is claimed until it is released.
//   A released reservation was never received, so it does not count.
// - A refused request is not recorded. Otherwise a worker that keeps retrying
//   would keep the window full and the lead would never hear from us again.
// - maxPerWindow is a sliding window: for any moment `now`, the counted sends
//   in (now - windowHours, now] must stay below maxPerWindow. A fixed window
//   would let a lead receive double the limit across a window boundary.
// - minGapMinutes is measured from the most recent counted send.

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

// Entries older than this are pruned. Requests may not use a window longer
// than this, because pruned history could not answer them.
const HISTORY_RETENTION_MS = 30 * 24 * HOUR_MS;

// The lock is held for a few milliseconds. A lock older than LOCK_STALE_MS
// was left behind by a crashed process and may be broken.
const LOCK_TIMEOUT_MS = 10 * 1000;
const LOCK_STALE_MS = 15 * 1000;

const ID_PATTERN = /^r1\.([0-9a-f]{64})\.[0-9a-f]{16}$/;

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR environment variable is not set');
  return dir;
}

function leadKey(userId) {
  return createHash('sha256').update(userId).digest('hex');
}

function validateRequest(request, now) {
  if (!request || typeof request.userId !== 'string' || request.userId === '') {
    throw new TypeError('request.userId must be a non-empty string');
  }
  if (!Number.isInteger(request.maxPerWindow) || request.maxPerWindow < 1) {
    throw new TypeError('request.maxPerWindow must be an integer >= 1');
  }
  if (!Number.isFinite(request.windowHours) || request.windowHours <= 0) {
    throw new TypeError('request.windowHours must be a number > 0');
  }
  if (request.windowHours * HOUR_MS > HISTORY_RETENTION_MS) {
    throw new RangeError('request.windowHours may not exceed 720 (30 days)');
  }
  if (!Number.isFinite(request.minGapMinutes) || request.minGapMinutes < 0) {
    throw new TypeError('request.minGapMinutes must be a number >= 0');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDirs(dir) {
  await fs.mkdir(path.join(dir, 'leads'), { recursive: true });
  await fs.mkdir(path.join(dir, 'locks'), { recursive: true });
}

// Breaks a lock directory only when it is clearly abandoned.
async function breakIfStale(lockDir) {
  try {
    const stat = await fs.stat(lockDir);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      await fs.rmdir(lockDir);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// Runs fn while holding the lock for one lead. mkdir is atomic on a local
// filesystem, so only one process at a time can create the lock directory.
async function withLead(dir, key, fn) {
  const lockDir = path.join(dir, 'locks', `${key}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      await fs.mkdir(lockDir);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      await breakIfStale(lockDir);
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for the lock on lead ${key}`);
      }
      await sleep(5 + Math.random() * 15);
    }
  }

  try {
    return await fn();
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true });
  }
}

async function readHistory(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// Writes to a temp file, syncs it, then renames over the old file. A crash
// leaves either the old history or the new one, never a half-written file.
async function writeHistory(file, entries) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify(entries));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
}

/**
 * Claims a send slot for one lead.
 *
 * @param {{userId: string, maxPerWindow: number, windowHours: number, minGapMinutes: number}} request
 * @param {Date} now
 * @returns {Promise<{allowed: boolean, reason: string | null, reservationId: string | null}>}
 *   reason is 'min_gap_not_elapsed' or 'max_per_window_reached' when refused.
 */
export async function reserve(request, now) {
  validateRequest(request, now);

  const dir = stateDir();
  const key = leadKey(request.userId);
  const file = path.join(dir, 'leads', `${key}.json`);
  const nowMs = now.getTime();
  const windowMs = request.windowHours * HOUR_MS;
  const gapMs = request.minGapMinutes * MINUTE_MS;

  await ensureDirs(dir);

  return withLead(dir, key, async () => {
    const entries = (await readHistory(file)).filter(
      (entry) => entry.at > nowMs - HISTORY_RETENTION_MS,
    );
    const counted = entries.filter((entry) => !entry.released);

    if (gapMs > 0 && counted.length > 0) {
      const lastAt = Math.max(...counted.map((entry) => entry.at));
      if (nowMs - lastAt < gapMs) {
        return { allowed: false, reason: 'min_gap_not_elapsed', reservationId: null };
      }
    }

    const inWindow = counted.filter((entry) => entry.at > nowMs - windowMs).length;
    if (inWindow >= request.maxPerWindow) {
      return { allowed: false, reason: 'max_per_window_reached', reservationId: null };
    }

    const reservationId = `r1.${key}.${randomBytes(8).toString('hex')}`;
    entries.push({ id: reservationId, at: nowMs, released: false });
    await writeHistory(file, entries);
    return { allowed: true, reason: null, reservationId };
  });
}

/**
 * Gives back a slot whose message the provider rejected, so it does not
 * count against the limits. Safe to call from any process. Releasing an
 * unknown or already released id does nothing.
 *
 * @param {string} reservationId
 * @returns {Promise<void>}
 */
export async function release(reservationId) {
  const match = typeof reservationId === 'string' ? ID_PATTERN.exec(reservationId) : null;
  if (!match) {
    throw new TypeError('reservationId must be an id returned by reserve()');
  }

  const dir = stateDir();
  const key = match[1];
  const file = path.join(dir, 'leads', `${key}.json`);

  await ensureDirs(dir);

  await withLead(dir, key, async () => {
    const entries = await readHistory(file);
    const entry = entries.find((candidate) => candidate.id === reservationId);
    if (!entry || entry.released) return;
    entry.released = true;
    await writeHistory(file, entries);
  });
}
