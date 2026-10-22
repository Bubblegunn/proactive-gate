// Shared send rate limiter for proactive follow-up messages.
//
// State lives in STATE_DIR so every worker process on this machine sees the
// same history and it survives restarts:
//   STATE_DIR/leads/<sha256(userId)>.json  send history for one lead
//   STATE_DIR/locks/<sha256(userId)>.lock  per-lead mutex (a directory)
//
// What counts toward the limits:
//   - Only reservations that were allowed and not released. A denied request
//     is never recorded, so retries do not push the lead further into a block.
//   - A released reservation (provider rejected the message) is not counted.
//   - A reservation that is never released is counted, even if the worker
//     died before sending. Over-counting is the safe side for sender reputation.
//
// How the limits work (based on what the lead experiences):
//   - Window: sliding. Any rolling window of windowHours contains at most
//     maxPerWindow sends. A fixed calendar window would allow a burst at the
//     end of one window and the start of the next.
//   - Gap: symmetric. No counted send may be closer than minGapMinutes to
//     `now`, whether it is earlier or later. Callers may pass `now` values
//     slightly out of order, so the check does not assume arrival order.
//
// Concurrency: all reads and writes for one lead happen under that lead's
// lock. The lock is a directory created with mkdir, which is atomic. Writes go
// to a temp file that is fsynced and then renamed over the history file, so a
// crash leaves either the old or the new history, never a partial one.
// STATE_DIR must be on a local filesystem (NFS does not give reliable mkdir
// atomicity across machines, and this design targets one machine).

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
// History older than this is dropped. windowHours is capped at 720 (30 days)
// so no window is ever longer than the retained history.
const RETENTION_MS = 30 * 24 * HOUR_MS;
const MAX_WINDOW_HOURS = 720;
const LOCK_STALE_MS = 10 * 1000;
const LOCK_TIMEOUT_MS = 5 * 1000;
const LOCK_RETRY_BASE_MS = 5;

export async function reserve(request, now) {
  const req = validateRequest(request);
  const nowMs = validateNow(now);
  const dir = await prepareStateDir();
  const key = leadKey(req.userId);
  const file = historyFile(dir, key);

  return withLock(dir, key, async () => {
    const history = (await readHistory(file)).filter(
      (entry) => nowMs - entry.at < RETENTION_MS,
    );
    const counted = history.filter((entry) => !entry.released);

    const windowStart = nowMs - req.windowHours * HOUR_MS;
    const sentInWindow = counted.filter((entry) => entry.at > windowStart);
    if (sentInWindow.length >= req.maxPerWindow) {
      return denied('window_limit_reached');
    }

    const gapMs = req.minGapMinutes * MINUTE_MS;
    if (counted.some((entry) => Math.abs(nowMs - entry.at) < gapMs)) {
      return denied('min_gap_not_elapsed');
    }

    const reservationId = `${key}.${randomUUID()}`;
    history.push({ id: reservationId, at: nowMs, released: false });
    await writeHistory(file, history);
    return { allowed: true, reason: null, reservationId };
  });
}

export async function release(reservationId) {
  const key = keyFromReservationId(reservationId);
  if (key === null) return false;

  const dir = await prepareStateDir();
  const file = historyFile(dir, key);

  return withLock(dir, key, async () => {
    const history = await readHistory(file);
    const entry = history.find((item) => item.id === reservationId);
    if (!entry || entry.released) return false;
    entry.released = true;
    await writeHistory(file, history);
    return true;
  });
}

function denied(reason) {
  return { allowed: false, reason, reservationId: null };
}

function validateRequest(request) {
  if (request === null || typeof request !== 'object') {
    throw new TypeError('request must be an object');
  }
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request;
  if (typeof userId !== 'string' || userId === '') {
    throw new TypeError('request.userId must be a non-empty string');
  }
  if (!Number.isInteger(maxPerWindow) || maxPerWindow < 0) {
    throw new TypeError('request.maxPerWindow must be a non-negative integer');
  }
  if (!Number.isFinite(windowHours) || windowHours <= 0 || windowHours > MAX_WINDOW_HOURS) {
    throw new RangeError(`request.windowHours must be in (0, ${MAX_WINDOW_HOURS}]`);
  }
  if (!Number.isFinite(minGapMinutes) || minGapMinutes < 0) {
    throw new TypeError('request.minGapMinutes must be a non-negative number');
  }
  return { userId, maxPerWindow, windowHours, minGapMinutes };
}

function validateNow(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  return now.getTime();
}

function leadKey(userId) {
  return createHash('sha256').update(userId, 'utf8').digest('hex');
}

// reservationId is "<64 hex chars>.<uuid>", so the lead key can be recovered
// without knowing the userId. That lets any worker release any reservation.
function keyFromReservationId(reservationId) {
  if (typeof reservationId !== 'string') return null;
  const match = /^([0-9a-f]{64})\.[0-9a-f-]{36}$/.exec(reservationId);
  return match ? match[1] : null;
}

function historyFile(dir, key) {
  return path.join(dir, 'leads', `${key}.json`);
}

async function prepareStateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  await mkdir(path.join(dir, 'leads'), { recursive: true });
  await mkdir(path.join(dir, 'locks'), { recursive: true });
  return dir;
}

async function withLock(dir, key, fn) {
  const lockDir = path.join(dir, 'locks', `${key}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    await breakIfStale(lockDir);
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for rate-limit lock ${key}`);
    }
    await sleep(LOCK_RETRY_BASE_MS + Math.random() * LOCK_RETRY_BASE_MS);
  }

  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

// A worker that died while holding the lock leaves the directory behind. The
// lock is only held for milliseconds, so one older than LOCK_STALE_MS is dead.
// Renaming it first means only one waiter removes it.
async function breakIfStale(lockDir) {
  let info;
  try {
    info = await stat(lockDir);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (Date.now() - info.mtimeMs < LOCK_STALE_MS) return;

  const graveyard = `${lockDir}.stale-${randomUUID()}`;
  try {
    await rename(lockDir, graveyard);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  await rm(graveyard, { recursive: true, force: true });
}

async function readHistory(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  // A corrupt file throws. The caller then sends nothing, which fails safe.
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error(`rate-limit history is not an array: ${file}`);
  }
  return parsed;
}

async function writeHistory(file, entries) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify(entries));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);

  const dirHandle = await open(path.dirname(file), 'r');
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
