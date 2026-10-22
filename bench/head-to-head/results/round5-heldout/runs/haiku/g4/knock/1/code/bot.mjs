// Shared per-lead send limiter for many worker processes on one machine.
//
// State lives in STATE_DIR:
//   leads/<sha256(userId)>.json  send history for one lead
//   locks/<sha256(userId)>.lock  mkdir-based mutex held for one read-modify-write
//
// Rules, as the recipient experiences them:
//   - A send counts from the moment it is reserved until it is released.
//     Released reservations (provider rejected, lead never got it) do not count.
//   - maxPerWindow is a sliding window: at most N sends in any span of windowHours.
//   - minGapMinutes is a spacing rule: no two sends to the same lead closer than
//     that, in either direction. This holds even if callers' clocks deliver calls
//     out of order.
//   - A reservation whose worker crashed before sending still counts. That is the
//     conservative choice: a lead is never messaged more often than the limits allow.

import { mkdir, readFile, rename, rm, stat, writeFile, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const LOCK_STALE_MS = 5_000;
const LOCK_TIMEOUT_MS = 10_000;

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

async function ensureDirs(dir) {
  await mkdir(join(dir, 'leads'), { recursive: true });
  await mkdir(join(dir, 'locks'), { recursive: true });
}

function leadKey(userId) {
  return createHash('sha256').update(userId).digest('hex');
}

function validateReserve(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request ?? {};
  if (typeof userId !== 'string' || userId === '') {
    throw new TypeError('userId must be a non-empty string');
  }
  if (!Number.isFinite(maxPerWindow) || maxPerWindow < 0) {
    throw new TypeError('maxPerWindow must be a non-negative number');
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
  return { userId, maxPerWindow, windowMs: windowHours * HOUR_MS, gapMs: minGapMinutes * MINUTE_MS };
}

async function breakIfStale(lockPath) {
  try {
    const { mtimeMs } = await stat(lockPath);
    if (Date.now() - mtimeMs > LOCK_STALE_MS) {
      await rm(lockPath, { recursive: true, force: true });
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// Runs fn while holding the per-lead lock. mkdir is atomic on a local filesystem,
// so only one process at a time gets past it. A lock left behind by a crashed
// process is removed once it is older than LOCK_STALE_MS.
async function withLead(dir, key, fn) {
  const lockPath = join(dir, 'locks', `${key}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      await breakIfStale(lockPath);
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for lead lock ${key}`);
      }
      await sleep(5 + Math.random() * 15);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function loadLead(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { retainMs: 0, reservations: [] };
    throw err;
  }
}

// Write to a temp file, fsync it, then rename over the old file. A reader or a
// restarted worker sees either the old history or the new one, never a partial file.
async function saveLead(file, state) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify(state));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

/**
 * Claims a send slot for one lead.
 * @param {{userId: string, maxPerWindow: number, windowHours: number, minGapMinutes: number}} request
 * @param {Date} now
 * @returns {Promise<{allowed: boolean, reason: string|null, reservationId: string|null}>}
 */
export async function reserve(request, now) {
  const { userId, maxPerWindow, windowMs, gapMs } = validateReserve(request, now);
  const dir = stateDir();
  await ensureDirs(dir);

  const key = leadKey(userId);
  const file = join(dir, 'leads', `${key}.json`);
  const t = now.getTime();

  return withLead(dir, key, async () => {
    const state = await loadLead(file);
    // Keep history at least as long as the largest window or gap any caller has used.
    state.retainMs = Math.max(state.retainMs, windowMs, gapMs);
    state.reservations = state.reservations.filter((r) => t - r.at < state.retainMs);

    const held = state.reservations.filter((r) => !r.released);
    const sentInWindow = held.filter((r) => r.at > t - windowMs).length;

    let reason = null;
    if (sentInWindow >= maxPerWindow) {
      reason = 'window_limit_reached';
    } else if (gapMs > 0 && held.some((r) => Math.abs(t - r.at) < gapMs)) {
      reason = 'min_gap_not_elapsed';
    }
    if (reason) return { allowed: false, reason, reservationId: null };

    const id = randomUUID();
    state.reservations.push({ id, at: t, released: false });
    await saveLead(file, state);
    return { allowed: true, reason: null, reservationId: `${key}.${id}` };
  });
}

/**
 * Gives back a slot the provider did not deliver. Safe to call more than once.
 * Works from any process that shares STATE_DIR.
 * @param {string} reservationId
 * @returns {Promise<boolean>} true if this call released the slot, false if it was
 *   already released or is no longer in the history.
 */
export async function release(reservationId) {
  const dot = typeof reservationId === 'string' ? reservationId.indexOf('.') : -1;
  if (dot <= 0) throw new TypeError('reservationId is not valid');
  const key = reservationId.slice(0, dot);
  const id = reservationId.slice(dot + 1);

  const dir = stateDir();
  await ensureDirs(dir);
  const file = join(dir, 'leads', `${key}.json`);

  return withLead(dir, key, async () => {
    const state = await loadLead(file);
    const r = state.reservations.find((x) => x.id === id);
    if (!r || r.released) return false;
    r.released = true;
    await saveLead(file, state);
    return true;
  });
}
