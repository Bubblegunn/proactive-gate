// Shared send rate limiter for proactive lead messages.
//
// State lives in STATE_DIR so every worker process sees the same history and
// it survives restarts. Layout:
//   STATE_DIR/users/<sha256(userId)>/<uuid>.json   one file per sent slot
//   STATE_DIR/users/<sha256(userId)>/.lock/        mkdir-based lock per lead
//
// A slot counts toward the limits from the moment it is reserved until it is
// released. Released slots are deleted, so they never count. A reserved slot
// is treated as sent even if the send is still in flight: an unknown outcome
// is counted, which is the safe side for the recipient.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const RETENTION_MS = 30 * 24 * HOUR; // slots older than this are pruned
const MAX_WINDOW_HOURS = 720; // must stay within RETENTION_MS
const LOCK_STALE_MS = 10_000; // a lock older than this came from a crashed holder
const LOCK_TIMEOUT_MS = 10_000;
const RESERVATION_ID = /^[0-9a-f]{64}\.[0-9a-f-]{36}$/;

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function hashUser(userId) {
  return createHash('sha256').update(userId).digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withUserLock(userDir, fn) {
  const lock = path.join(userDir, '.lock');
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const info = await stat(lock);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rmdir(lock).catch(() => {});
          continue;
        }
      } catch (statErr) {
        if (statErr.code === 'ENOENT') continue; // holder just released it
        throw statErr;
      }
      if (Date.now() > deadline) throw new Error('timed out waiting for rate-limit lock');
      await sleep(5 + Math.random() * 15);
    }
  }
  try {
    return await fn();
  } finally {
    await rmdir(lock).catch(() => {});
  }
}

async function readEntries(userDir) {
  let names;
  try {
    names = await readdir(userDir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const entries = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    let record;
    try {
      record = JSON.parse(await readFile(path.join(userDir, name), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') continue; // released between readdir and read
      throw err;
    }
    entries.push({ id: name.slice(0, -'.json'.length), at: record.at, file: path.join(userDir, name) });
  }
  return entries;
}

async function writeEntry(userDir, id, record) {
  // Temp file then rename, so a reader never sees a half-written slot.
  const tmp = path.join(userDir, `.tmp-${id}`);
  await writeFile(tmp, JSON.stringify(record));
  await rename(tmp, path.join(userDir, `${id}.json`));
}

export async function reserve(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request ?? {};
  if (typeof userId !== 'string' || userId === '') throw new TypeError('userId must be a non-empty string');
  if (!Number.isInteger(maxPerWindow) || maxPerWindow < 1) throw new TypeError('maxPerWindow must be a positive integer');
  if (!(windowHours > 0 && windowHours <= MAX_WINDOW_HOURS)) throw new TypeError(`windowHours must be > 0 and <= ${MAX_WINDOW_HOURS}`);
  if (!(minGapMinutes >= 0)) throw new TypeError('minGapMinutes must be >= 0');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');

  const userHash = hashUser(userId);
  const userDir = path.join(stateDir(), 'users', userHash);
  await mkdir(userDir, { recursive: true });

  const nowMs = now.getTime();
  const windowMs = windowHours * HOUR;
  const gapMs = minGapMinutes * MINUTE;

  return withUserLock(userDir, async () => {
    const entries = await readEntries(userDir);

    for (const e of entries) {
      if (e.at < nowMs - RETENTION_MS) await unlink(e.file).catch(() => {});
    }

    // A slot sent at T occupies the window (T, T + windowHours]: a lead who
    // got a message 24h ago is not counted against a 24h cap any more.
    // Entries after `now` (clock skew between workers) still count.
    const inWindow = entries.filter((e) => e.at > nowMs - windowMs);
    if (inWindow.length >= maxPerWindow) {
      return { allowed: false, reason: 'window_limit_reached', reservationId: null };
    }

    // Spacing is measured both ways so a slightly-ahead worker clock cannot
    // let two messages land close together.
    const tooClose = entries.some((e) => Math.abs(nowMs - e.at) < gapMs);
    if (tooClose) {
      return { allowed: false, reason: 'min_gap_not_elapsed', reservationId: null };
    }

    const id = randomUUID();
    await writeEntry(userDir, id, { at: nowMs });
    return { allowed: true, reason: null, reservationId: `${userHash}.${id}` };
  });
}

export async function release(reservationId) {
  // Unknown, malformed or already-released ids are no-ops, so a retried
  // release is safe. The id carries the user hash, so any worker can release.
  if (typeof reservationId !== 'string' || !RESERVATION_ID.test(reservationId)) return;
  const [userHash, id] = reservationId.split('.');
  const file = path.join(stateDir(), 'users', userHash, `${id}.json`);
  await unlink(file).catch((err) => {
    if (err.code !== 'ENOENT') throw err;
  });
}
