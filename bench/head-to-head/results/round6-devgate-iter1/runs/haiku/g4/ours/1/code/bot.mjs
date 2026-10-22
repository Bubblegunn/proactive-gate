// Shared send rate limiter. Every worker calls reserve() before sending and
// release() if the provider rejected the message. State lives in STATE_DIR so
// all workers on this machine see the same history and it survives restarts.
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const LOCK_STALE_MS = 10_000; // a lock older than this belongs to a crashed worker
const LOCK_WAIT_MS = 5_000; // give up waiting for a lock after this long
const RETENTION_MS = 30 * 24 * HOUR; // entries older than this are pruned

// Reservation status:
//  'held'     - claimed; counts toward limits (includes unknown outcomes, which
//               stay held because the lead may already have received the text)
//  'released' - provider rejected, lead never received it; counts toward nothing
const HELD = 'held';
const RELEASED = 'released';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// STATE_DIR is read on every call, never cached at import time.
async function stateBase() {
  const root = process.env.STATE_DIR;
  if (!root) throw new Error('STATE_DIR is not set');
  const base = path.resolve(root, 'send-limits');
  await mkdir(base, { recursive: true });
  return base;
}

// One file per lead. The hash keeps file names safe for any userId string.
function userKey(userId) {
  return createHash('sha256').update(userId).digest('hex').slice(0, 32);
}

async function withLock(base, key, fn) {
  const lockPath = path.join(base, `${key}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lockPath); // atomic: exactly one process succeeds
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statErr) {
        if (statErr.code !== 'ENOENT') throw statErr;
        continue; // holder just released it
      }
      if (Date.now() > deadline) {
        // Throw, not refuse: nothing was reserved, so the caller must not send.
        throw new Error(`send-limit lock busy for ${key}`);
      }
      await sleep(5 + Math.random() * 20);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function loadHistory(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { entries: [] };
    throw err; // corrupt file: fail closed, the caller sends nothing
  }
}

async function saveHistory(file, data) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file); // atomic replace: readers see old or new, never half a file
}

function checkRequest(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request ?? {};
  if (typeof userId !== 'string' || userId === '') throw new TypeError('userId must be a non-empty string');
  if (!Number.isInteger(maxPerWindow) || maxPerWindow < 1) throw new TypeError('maxPerWindow must be an integer >= 1');
  if (!(windowHours > 0)) throw new TypeError('windowHours must be > 0');
  if (!(minGapMinutes >= 0)) throw new TypeError('minGapMinutes must be >= 0');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
}

export async function reserve(request, now) {
  checkRequest(request, now);
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request;
  const t = now.getTime();
  const windowMs = windowHours * HOUR;
  const gapMs = minGapMinutes * MINUTE;

  const base = await stateBase();
  const key = userKey(userId);
  const file = path.join(base, `${key}.json`);

  return withLock(base, key, async () => {
    const history = await loadHistory(file);
    const entries = history.entries.filter((e) => t - e.at < RETENTION_MS);
    const held = entries.filter((e) => e.status === HELD);

    // Minimum gap between consecutive sends, in either direction, so a
    // send stamped slightly ahead (clock skew) still counts.
    if (held.some((e) => Math.abs(t - e.at) < gapMs)) {
      await saveHistory(file, { entries }); // persist pruning only
      return { allowed: false, reason: 'min_gap_not_elapsed', reservationId: null };
    }

    // Sliding window: sends in the last windowHours. A slot frees when the
    // oldest one in the window ages out, not at a fixed clock boundary.
    const inWindow = held.filter((e) => e.at > t - windowMs && e.at <= t);
    if (inWindow.length >= maxPerWindow) {
      await saveHistory(file, { entries });
      return { allowed: false, reason: 'max_per_window_reached', reservationId: null };
    }

    const reservationId = `${key}.${randomBytes(12).toString('hex')}`;
    entries.push({ id: reservationId, at: t, status: HELD });
    await saveHistory(file, { entries });
    return { allowed: true, reason: null, reservationId };
  });
}

export async function release(reservationId) {
  const match = /^([0-9a-f]{32})\.[0-9a-f]{24}$/.exec(String(reservationId ?? ''));
  if (!match) return false;
  const key = match[1];
  const base = await stateBase();
  const file = path.join(base, `${key}.json`);

  return withLock(base, key, async () => {
    const history = await loadHistory(file);
    const entry = history.entries.find((e) => e.id === reservationId);
    if (!entry || entry.status !== HELD) return false; // unknown or already released
    entry.status = RELEASED;
    await saveHistory(file, history);
    return true;
  });
}
