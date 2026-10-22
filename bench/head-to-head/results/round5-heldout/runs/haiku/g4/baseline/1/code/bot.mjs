// Shared per-lead send rate limiter.
//
// State lives in STATE_DIR so every worker process on the machine sees the
// same history and it survives restarts:
//   STATE_DIR/leads/<sha256(userId)>.json  { holds: [{ id, at }], retentionMs }
//   STATE_DIR/locks/<sha256(userId)>.lock/ (mkdir is the cross-process mutex)
//
// What counts: a reservation that is still held (allowed and not released)
// counts as a message the lead received. Denied requests and released
// reservations do not count.
//
// Limits, checked against the caller's `now`:
//   - min gap: no held send may be closer than minGapMinutes to this one, in
//     either direction (a recipient feels the distance to the nearest message).
//   - max per window: a sliding window. Any span of windowHours that contains
//     this send may hold at most maxPerWindow sends, counting this one. Fixed
//     calendar buckets would let a lead receive 2x the limit around a bucket
//     edge, so the window moves with each send.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const LOCK_STALE_MS = 10_000; // a lock is held for milliseconds; older means a crashed holder
const LOCK_RETRY_BASE_MS = 2;

export async function reserve(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = validateRequest(request);
  const t = validateNow(now);

  const windowMs = windowHours * HOUR_MS;
  const gapMs = minGapMinutes * MINUTE_MS;
  const dir = stateDir();
  await ensureDirs(dir);

  const key = keyOf(userId);
  const file = leadFile(dir, key);

  return withLock(dir, key, async () => {
    const lead = await loadLead(file);

    // Keep only history a future check could still need: the longest window or
    // gap seen for this lead. Entries older than that cannot affect any limit.
    const retentionMs = Math.max(lead.retentionMs, windowMs, gapMs);
    const holds = lead.holds.filter((h) => h.at > t - retentionMs);

    const result = checkLimits(holds, t, { maxPerWindow, windowMs, gapMs });
    if (!result.allowed) {
      await saveLead(file, { holds, retentionMs });
      return { allowed: false, reason: result.reason, reservationId: null };
    }

    const reservationId = `${key}.${randomUUID()}`;
    holds.push({ id: reservationId, at: t });
    await saveLead(file, { holds, retentionMs });
    return { allowed: true, reason: null, reservationId };
  });
}

export async function release(reservationId) {
  if (typeof reservationId !== 'string') return false;
  const dot = reservationId.indexOf('.');
  const key = reservationId.slice(0, dot);
  if (dot < 0 || !/^[0-9a-f]{64}$/.test(key)) return false;

  const dir = stateDir();
  await ensureDirs(dir);
  const file = leadFile(dir, key);

  return withLock(dir, key, async () => {
    const lead = await loadLead(file);
    const holds = lead.holds.filter((h) => h.id !== reservationId);
    if (holds.length === lead.holds.length) return false; // unknown or already released
    await saveLead(file, { holds, retentionMs: lead.retentionMs });
    return true;
  });
}

// Returns { allowed, reason } for a send at time t given the held sends.
function checkLimits(holds, t, { maxPerWindow, windowMs, gapMs }) {
  // Min gap: the nearest held send on either side must be at least gapMs away.
  if (holds.some((h) => Math.abs(t - h.at) < gapMs)) {
    return { allowed: false, reason: 'min_gap_not_elapsed' };
  }

  // Max per window: any window of length windowMs that contains t must hold at
  // most maxPerWindow sends counting this one. A window [a, a + windowMs) with
  // t - windowMs < a <= t contains t. The densest such window can be moved so
  // that its start sits on a held send (or on t), so those are the only
  // candidates to test.
  const candidates = [t, ...holds.map((h) => h.at).filter((at) => at <= t && at > t - windowMs)];
  for (const a of candidates) {
    const inWindow = holds.filter((h) => h.at >= a && h.at < a + windowMs).length;
    if (inWindow + 1 > maxPerWindow) {
      return { allowed: false, reason: 'max_per_window_exceeded' };
    }
  }

  return { allowed: true, reason: null };
}

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR environment variable is not set');
  return dir;
}

async function ensureDirs(dir) {
  await mkdir(path.join(dir, 'leads'), { recursive: true });
  await mkdir(path.join(dir, 'locks'), { recursive: true });
}

function keyOf(userId) {
  return createHash('sha256').update(userId).digest('hex');
}

function leadFile(dir, key) {
  return path.join(dir, 'leads', `${key}.json`);
}

async function loadLead(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { holds: [], retentionMs: 0 };
    throw err; // a corrupt file must not be silently treated as empty history
  }
}

// Write to a temp file, fsync, then rename, so a reader never sees a partial file
// and a crash leaves either the old or the new history.
async function saveLead(file, data) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(data));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
}

// mkdir is atomic across processes, so it works as a cross-worker mutex.
async function withLock(dir, key, fn) {
  const lockPath = path.join(dir, 'locks', `${key}.lock`);
  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (await removeIfStale(lockPath)) continue;
      await sleep(LOCK_RETRY_BASE_MS + Math.random() * LOCK_RETRY_BASE_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function removeIfStale(lockPath) {
  try {
    const st = await stat(lockPath);
    if (Date.now() - st.mtimeMs <= LOCK_STALE_MS) return false;
    await rm(lockPath, { recursive: true, force: true });
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return true; // released between our mkdir and stat
    throw err;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateRequest(request) {
  if (!request || typeof request !== 'object') throw new TypeError('request must be an object');
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request;
  if (typeof userId !== 'string' || userId === '') throw new TypeError('userId must be a non-empty string');
  if (!Number.isInteger(maxPerWindow) || maxPerWindow < 0) throw new TypeError('maxPerWindow must be an integer >= 0');
  if (!(typeof windowHours === 'number' && windowHours > 0)) throw new TypeError('windowHours must be > 0');
  if (!(typeof minGapMinutes === 'number' && minGapMinutes >= 0)) throw new TypeError('minGapMinutes must be >= 0');
  return { userId, maxPerWindow, windowHours, minGapMinutes };
}

function validateNow(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  return now.getTime();
}
