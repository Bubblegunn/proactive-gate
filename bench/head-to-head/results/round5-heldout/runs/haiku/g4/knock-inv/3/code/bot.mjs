// Shared per-lead send limiter. Every worker on the machine points at the same STATE_DIR.
// One JSON file per lead lists that lead's counted send slots. A mkdir-based lock
// serializes the read-modify-write for each lead across processes.
//
// What counts: a reservation counts from the moment it is granted until release() removes it.
// Denied calls never count. A held slot whose worker crashed still counts, because the
// message may already have gone out.
// Window: sliding. A slot stops counting once it is older than windowHours.

import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const LOCK_STALE_MS = 10_000;
const KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

export async function reserve(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request ?? {};
  if (typeof userId !== 'string' || userId === '') throw new TypeError('userId must be a non-empty string');
  if (!Number.isInteger(maxPerWindow) || maxPerWindow < 0) throw new TypeError('maxPerWindow must be an integer >= 0');
  if (!(windowHours > 0)) throw new TypeError('windowHours must be > 0');
  if (!(minGapMinutes >= 0)) throw new TypeError('minGapMinutes must be >= 0');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');

  const nowMs = now.getTime();
  const windowMs = windowHours * HOUR_MS;
  const gapMs = minGapMinutes * MINUTE_MS;
  const key = leadKey(userId);
  const dir = await prepareStateDir();

  return withLock(dir, key, async () => {
    const history = await loadHistory(dir, key);
    // Keep every send any limit could still see, for the longest span any caller has asked for.
    history.retainMs = Math.max(history.retainMs, windowMs, gapMs);
    history.sends = history.sends.filter((s) => s.at > nowMs - history.retainMs);

    const inWindow = history.sends.filter((s) => s.at > nowMs - windowMs).length;
    const lastAt = history.sends.reduce((max, s) => Math.max(max, s.at), -Infinity);

    let reason = null;
    if (inWindow >= maxPerWindow) reason = 'window_limit_reached';
    else if (history.sends.length > 0 && nowMs - lastAt < gapMs) reason = 'min_gap_not_elapsed';

    if (reason) {
      await saveHistory(dir, key, history);
      return { allowed: false, reason, reservationId: null };
    }

    const reservationId = `${key}.${randomUUID()}`;
    history.sends.push({ id: reservationId, at: nowMs });
    await saveHistory(dir, key, history);
    return { allowed: true, reason: null, reservationId };
  });
}

export async function release(reservationId) {
  if (typeof reservationId !== 'string') return false;
  const cut = reservationId.lastIndexOf('.');
  const key = cut > 0 ? reservationId.slice(0, cut) : '';
  if (!KEY_PATTERN.test(key)) return false;

  const dir = await prepareStateDir();
  return withLock(dir, key, async () => {
    const history = await loadHistory(dir, key);
    const before = history.sends.length;
    history.sends = history.sends.filter((s) => s.id !== reservationId);
    if (history.sends.length === before) return false;
    await saveHistory(dir, key, history);
    return true;
  });
}

function leadKey(userId) {
  return Buffer.from(userId, 'utf8').toString('base64url');
}

async function prepareStateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  await mkdir(path.join(dir, 'leads'), { recursive: true });
  await mkdir(path.join(dir, 'locks'), { recursive: true });
  return dir;
}

function leadFile(dir, key) {
  return path.join(dir, 'leads', `${key}.json`);
}

async function loadHistory(dir, key) {
  try {
    return JSON.parse(await readFile(leadFile(dir, key), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { retainMs: 0, sends: [] };
    throw err;
  }
}

// Write to a temp file, then rename, so a reader never sees a half-written file.
async function saveHistory(dir, key, history) {
  const file = leadFile(dir, key);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(history));
  await rename(tmp, file);
}

async function withLock(dir, key, body) {
  const lockPath = path.join(dir, 'locks', `${key}.lock`);
  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (await removeIfStale(lockPath)) continue;
      await sleep(2 + Math.random() * 8);
    }
  }
  try {
    return await body();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

// Returns true when the lock is gone (removed here, or already gone), so the caller retries at once.
async function removeIfStale(lockPath) {
  try {
    const { mtimeMs } = await stat(lockPath);
    if (Date.now() - mtimeMs < LOCK_STALE_MS) return false;
    await rm(lockPath, { recursive: true, force: true });
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return true;
    throw err;
  }
}
