// Shared per-lead send rate limiter.
//
// Every worker process points at the same STATE_DIR. Each lead has one JSON
// file under STATE_DIR/leads/. A per-lead lock directory (mkdir is atomic)
// serializes read-modify-write across processes, so two workers cannot both
// claim the last slot.
//
// What counts: every reservation that was allowed and not released. A
// blocked attempt does not count. A released reservation is removed, so the
// slot returns to the pool. Counting is per lead, not per channel, because
// the recipient experiences WhatsApp and SMS messages the same way.
//
// Window: sliding. A slot frees exactly windowHours after the send it
// represents. A fixed window would allow a double burst across its boundary.
//
// Gap: minGapMinutes is measured from the latest counted reservation. A
// negative gap (caller clock behind a stored reservation) also blocks.
//
// Retention: entries older than max(30 days, window, gap) are pruned. A
// window longer than 30 days can only see entries that were still stored
// when it was first used.

import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const RETENTION_FLOOR_MS = 30 * 24 * HOUR_MS;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 10_000;
const RESERVATION_ID = /^([0-9a-f]{64})\.[0-9a-f]{16}$/;

export async function reserve(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = parseRequest(request);
  const at = parseNow(now);
  const leads = await ensureLeadsDir();
  const key = leadKey(userId);
  const file = path.join(leads, `${key}.json`);
  const windowMs = windowHours * HOUR_MS;
  const gapMs = minGapMinutes * MINUTE_MS;

  return withLock(leads, key, async () => {
    const state = await readLead(file, userId);
    state.retentionMs = Math.max(state.retentionMs, RETENTION_FLOOR_MS, windowMs, gapMs);
    state.reservations = state.reservations.filter(r => r.at > at - state.retentionMs);

    const latest = state.reservations.reduce((max, r) => Math.max(max, r.at), -Infinity);
    const inWindow = state.reservations.filter(r => r.at > at - windowMs).length;

    let reason = null;
    if (latest > -Infinity && at - latest < gapMs) reason = 'min_gap_not_elapsed';
    else if (inWindow >= maxPerWindow) reason = 'window_limit_reached';

    if (reason) {
      await writeLead(file, state);
      return { allowed: false, reason, reservationId: null };
    }

    const reservationId = `${key}.${randomBytes(8).toString('hex')}`;
    state.reservations.push({ id: reservationId, at: at });
    await writeLead(file, state);
    return { allowed: true, reason: null, reservationId };
  });
}

export async function release(reservationId) {
  const match = typeof reservationId === 'string' ? RESERVATION_ID.exec(reservationId) : null;
  if (!match) return false;

  const leads = await ensureLeadsDir();
  const key = match[1];
  const file = path.join(leads, `${key}.json`);

  return withLock(leads, key, async () => {
    const state = await readLead(file, null);
    const kept = state.reservations.filter(r => r.id !== reservationId);
    if (kept.length === state.reservations.length) return false;
    state.reservations = kept;
    await writeLead(file, state);
    return true;
  });
}

function parseRequest(request) {
  if (!request || typeof request !== 'object') throw new TypeError('request must be an object');
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request;
  if (typeof userId !== 'string' || userId === '') throw new TypeError('userId must be a non-empty string');
  if (!Number.isInteger(maxPerWindow) || maxPerWindow < 1) throw new TypeError('maxPerWindow must be an integer >= 1');
  if (!Number.isFinite(windowHours) || windowHours <= 0) throw new TypeError('windowHours must be a number > 0');
  if (!Number.isFinite(minGapMinutes) || minGapMinutes < 0) throw new TypeError('minGapMinutes must be a number >= 0');
  return { userId, maxPerWindow, windowHours, minGapMinutes };
}

function parseNow(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('now must be a valid Date');
  return now.getTime();
}

async function ensureLeadsDir() {
  const stateDir = process.env.STATE_DIR;
  if (!stateDir) throw new Error('STATE_DIR is not set');
  const leads = path.join(stateDir, 'leads');
  await mkdir(leads, { recursive: true });
  return leads;
}

// Hashing keeps file names fixed-length and free of characters that are
// unsafe in paths. release() recovers the same key from the reservation id.
function leadKey(userId) {
  return createHash('sha256').update(userId).digest('hex');
}

// A missing file means no history. A corrupt file throws: silently resetting
// it would erase the history and let sends through, so the caller must fail.
async function readLead(file, userId) {
  try {
    const state = JSON.parse(await readFile(file, 'utf8'));
    return { userId: state.userId, retentionMs: state.retentionMs ?? 0, reservations: state.reservations };
  } catch (err) {
    if (err.code === 'ENOENT') return { userId, retentionMs: 0, reservations: [] };
    throw err;
  }
}

// Write to a temp file, fsync, then rename. A crash leaves either the old
// file or the new one, never a partial file.
async function writeLead(file, state) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify(state));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

async function withLock(leads, key, fn) {
  const lock = path.join(leads, `${key}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      await breakIfStale(lock);
      if (Date.now() > deadline) throw new Error(`rate limiter lock timeout for lead ${key.slice(0, 12)}`);
      await sleep(5 + Math.random() * 15);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

// A lock whose holder died stays forever. The holder only does a few ms of
// work under the lock, so a lock older than LOCK_STALE_MS is abandoned.
async function breakIfStale(lock) {
  try {
    const info = await stat(lock);
    if (Date.now() - info.mtimeMs > LOCK_STALE_MS) await rm(lock, { recursive: true, force: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}
