// Shared send limiter for proactive lead messages.
//
// Every worker on this machine asks reserve() before sending and calls
// release() if the provider rejects the message. History lives in
// STATE_DIR/leads/<sha256(userId)>.json, one file per lead, so it survives a
// worker restart and is visible to all workers.
//
// Concurrency: each lead has a lock directory (mkdir is atomic on a local
// filesystem). Read-check-write runs while holding that lock, so two workers
// cannot both take the last slot for the same lead.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const LOCK_STALE_MS = 10_000; // a holder works for milliseconds; older locks belong to a crashed worker
const LOCK_RETRY_MS = 5;
const KEY_PATTERN = /^[0-9a-f]{64}$/;

// Counts a reservation as a message the lead may have received:
// - a reservation counts from the moment it is granted, even if the send is still in flight
//   or the worker crashed before sending (the message may have gone out anyway);
// - release() removes the reservation, because the provider rejected it and the lead got nothing.
// Blocked attempts are never recorded: the lead did not receive them.
//
// Window: sliding. A send counts for windowHours after it was granted. Fixed
// calendar windows would allow a burst of 2 × maxPerWindow around a boundary.
// Gap: minGapMinutes must pass since the most recent counted send.
//
// Reason codes (one per limit):
//   max_per_window_exceeded - maxPerWindow sends already fall inside the window
//   min_gap_not_elapsed     - the last send is less than minGapMinutes ago

export async function reserve(request, now) {
  const req = validateRequest(request);
  const at = validateNow(now);
  const stateDir = requireStateDir();
  const key = hashUser(req.userId);
  const windowMs = req.windowHours * HOUR_MS;
  const gapMs = req.minGapMinutes * MINUTE_MS;

  return withLead(stateDir, key, async (file) => {
    const state = await loadState(file);
    // Keep history as long as the longest window or gap any call has used,
    // so the check below still sees every send that matters.
    state.keepMs = Math.max(state.keepMs ?? 0, windowMs, gapMs);
    state.userId = req.userId;
    state.reservations = state.reservations.filter((r) => r.at > at - state.keepMs);

    const inWindow = state.reservations.filter((r) => r.at > at - windowMs);
    if (inWindow.length >= req.maxPerWindow) {
      return { allowed: false, reason: 'max_per_window_exceeded', reservationId: null };
    }

    const last = state.reservations.reduce((max, r) => Math.max(max, r.at), -Infinity);
    if (at - last < gapMs) {
      return { allowed: false, reason: 'min_gap_not_elapsed', reservationId: null };
    }

    // Reservation id = <lead key>.<uuid>, so release() can find the file without a userId.
    const reservationId = `${key}.${randomUUID()}`;
    state.reservations.push({ id: reservationId, at: at.getTime() });
    await saveState(file, state);
    return { allowed: true, reason: null, reservationId };
  });
}

export async function release(reservationId) {
  if (typeof reservationId !== 'string') {
    throw new TypeError('reservationId must be a string');
  }
  const dot = reservationId.indexOf('.');
  const key = reservationId.slice(0, dot);
  if (dot < 0 || !KEY_PATTERN.test(key)) {
    // Not an id this module issued. Nothing to give back.
    return;
  }
  const stateDir = requireStateDir();

  await withLead(stateDir, key, async (file) => {
    const state = await loadState(file);
    const remaining = state.reservations.filter((r) => r.id !== reservationId);
    if (remaining.length === state.reservations.length) return; // already released or pruned
    state.reservations = remaining;
    await saveState(file, state);
  });
}

// ---------- helpers ----------

function requireStateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR environment variable is not set');
  return dir;
}

function hashUser(userId) {
  return createHash('sha256').update(userId).digest('hex');
}

function validateRequest(request) {
  if (!request || typeof request !== 'object') {
    throw new TypeError('request must be an object');
  }
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request;
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new TypeError('userId must be a non-empty string');
  }
  if (!Number.isInteger(maxPerWindow) || maxPerWindow < 1) {
    throw new TypeError('maxPerWindow must be an integer >= 1');
  }
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    throw new TypeError('windowHours must be a number > 0');
  }
  if (!Number.isFinite(minGapMinutes) || minGapMinutes < 0) {
    throw new TypeError('minGapMinutes must be a number >= 0');
  }
  return { userId, maxPerWindow, windowHours, minGapMinutes };
}

function validateNow(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  return now;
}

// Runs fn(file) while holding the lock for one lead.
async function withLead(stateDir, key, fn) {
  const leadsDir = join(stateDir, 'leads');
  await mkdir(leadsDir, { recursive: true });
  const lockPath = join(leadsDir, `${key}.lock`);
  await acquire(lockPath);
  try {
    return await fn(join(leadsDir, `${key}.json`));
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function acquire(lockPath) {
  for (;;) {
    try {
      await mkdir(lockPath);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    try {
      const { mtimeMs } = await stat(lockPath);
      if (Date.now() - mtimeMs > LOCK_STALE_MS) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      continue; // holder released between our mkdir and stat
    }
    await sleep(LOCK_RETRY_MS + Math.random() * LOCK_RETRY_MS);
  }
}

async function loadState(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { reservations: [] };
    throw err;
  }
  // A corrupt file throws instead of resetting: a reset would silently lift every limit.
  return JSON.parse(raw);
}

// Write to a temp file, fsync, then rename, so a crash never leaves a half-written history.
async function saveState(file, state) {
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
