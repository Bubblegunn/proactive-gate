// Shared send-rate limiter for lead follow-ups.
//
// All worker processes on one machine share STATE_DIR. Each lead has its own
// history file, guarded by a lock directory, so reserve() and release() from
// any process see one consistent history. History survives restarts because
// it lives on disk.
//
// What counts toward the limits:
//   - A reservation counts from the moment reserve() allows it until release()
//     removes it. A reservation whose worker crashed before sending still counts.
//     Over-counting only means fewer sends, which is the safe direction here.
//   - A rejected reserve() is never recorded, so denied attempts do not extend
//     the lead's cooldown.
//   - A released reservation (provider rejected the message) is removed, so it
//     no longer counts.
//
// How the limits move:
//   - maxPerWindow is a rolling window: at time T, the count is the number of
//     sends in (T - windowHours, T]. The lead experiences the last N hours, not
//     a calendar day, so a fixed-bucket reset would allow bursts at the boundary.
//   - minGapMinutes is measured from the most recent counted send.
//
// Checks run window first, then gap. The first limit that fails is the reason.

import { mkdir, readFile, rename, rm, stat, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

// Lock holds are a few milliseconds. A lock older than LOCK_STALE_MS was left
// behind by a crashed worker and may be broken.
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 10000;

class LockBusyError extends Error {
  constructor() {
    super('rate limiter lock is busy');
    this.name = 'LockBusyError';
  }
}

function stateLeadsDir() {
  const stateDir = process.env.STATE_DIR;
  if (!stateDir) throw new Error('STATE_DIR environment variable is not set');
  return join(stateDir, 'leads');
}

async function ensureLeadsDir() {
  const dir = stateLeadsDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

// Hash the userId so any string is safe as a file name.
function keyFor(userId) {
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
    throw new RangeError('maxPerWindow must be an integer >= 1');
  }
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    throw new RangeError('windowHours must be a finite number > 0');
  }
  if (!Number.isFinite(minGapMinutes) || minGapMinutes < 0) {
    throw new RangeError('minGapMinutes must be a finite number >= 0');
  }
  return { userId, maxPerWindow, windowHours, minGapMinutes };
}

function validateNow(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  return now.getTime();
}

// Break a lock only if it is clearly abandoned. The check and the removal are
// not atomic. The stale threshold is much longer than any lock hold, so a live
// holder being broken in that gap is not expected.
async function breakIfStale(lockDir) {
  let info;
  try {
    info = await stat(lockDir);
  } catch {
    return;
  }
  if (Date.now() - info.mtimeMs < LOCK_STALE_MS) return;
  await rm(lockDir, { recursive: true, force: true }).catch(() => {});
}

async function withLock(lockDir, fn) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      await breakIfStale(lockDir);
      if (Date.now() > deadline) throw new LockBusyError();
      await sleep(5 + Math.random() * 20);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true }).catch(() => {});
  }
}

// History shape: { retainMs, reservations: [{ id, at }] }, where at is epoch ms.
async function loadHistory(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { retainMs: 0, reservations: [] };
    throw err;
  }
}

// Write to a temp file, fsync, then rename. A crash never leaves a half-written
// history file behind.
async function saveHistory(file, history) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify(history));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

// reserve() and release() both lock the lead's history, so they never race.
export async function reserve(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = validateRequest(request);
  const nowMs = validateNow(now);
  const windowMs = windowHours * HOUR_MS;
  const gapMs = minGapMinutes * MINUTE_MS;

  const dir = await ensureLeadsDir();
  const key = keyFor(userId);
  const file = join(dir, `${key}.json`);

  try {
    return await withLock(join(dir, `${key}.lock`), async () => {
      const history = await loadHistory(file);

      // Keep entries long enough for the largest window this lead has been
      // checked against. The newest entry is always kept, so the gap check has
      // its reference point.
      history.retainMs = Math.max(history.retainMs ?? 0, windowMs);
      const cutoff = nowMs - history.retainMs;
      const newest = history.reservations.reduce(
        (max, r) => (r.at > max ? r.at : max),
        -Infinity,
      );
      history.reservations = history.reservations.filter(
        (r) => r.at >= cutoff || r.at === newest,
      );

      const inWindow = history.reservations.filter((r) => r.at > nowMs - windowMs).length;
      let reason = null;
      if (inWindow >= maxPerWindow) {
        reason = 'max_per_window_reached';
      } else if (newest !== -Infinity && nowMs - newest < gapMs) {
        // A negative difference means the newest send is ahead of this caller's
        // clock (clock skew). That still counts as too recent.
        reason = 'min_gap_not_elapsed';
      }

      if (reason) {
        await saveHistory(file, history);
        return { allowed: false, reason, reservationId: null };
      }

      const id = randomUUID();
      history.reservations.push({ id, at: nowMs });
      await saveHistory(file, history);
      return { allowed: true, reason: null, reservationId: `${key}.${id}` };
    });
  } catch (err) {
    if (err instanceof LockBusyError) {
      // Fail closed: the caller does not send when it cannot check the limits.
      return { allowed: false, reason: 'limiter_busy', reservationId: null };
    }
    throw err;
  }
}

// Returns true if a reservation was removed. Returns false for an unknown,
// malformed, or already-released id. Throws if the lock cannot be acquired.
// A throw means the slot was not returned, so the caller should retry or report.
export async function release(reservationId) {
  if (typeof reservationId !== 'string') return false;
  const match = /^([0-9a-f]{64})\.([0-9a-f-]{36})$/.exec(reservationId);
  if (!match) return false;
  const [, key, id] = match;

  const dir = await ensureLeadsDir();
  const file = join(dir, `${key}.json`);

  return withLock(join(dir, `${key}.lock`), async () => {
    const history = await loadHistory(file);
    const before = history.reservations.length;
    history.reservations = history.reservations.filter((r) => r.id !== id);
    if (history.reservations.length === before) return false;
    await saveHistory(file, history);
    return true;
  });
}
