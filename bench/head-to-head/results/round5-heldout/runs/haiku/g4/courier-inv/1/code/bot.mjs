// Shared per-lead send limiter. Every worker on the machine calls reserve()
// before sending and release() if the provider rejects the message.
//
// State lives in STATE_DIR so it survives restarts and is shared by all workers:
//   STATE_DIR/leads/<sha256(userId)>.json   one file per lead, the send history
//   STATE_DIR/locks/<sha256(userId)>.lock   mkdir-based mutex, held for a few ms
//
// Counting rules (what the recipient experiences):
// - A reservation counts from the moment it is granted, even if the send has not
//   finished yet. Unknown outcomes are treated as sent, which errs on the side of
//   sending less.
// - A released reservation stops counting, because the lead never got the message.
// - The window is a rolling window: a send counts for maxPerWindow until windowHours
//   after it was made. Fixed calendar windows would allow bursts across a boundary.
// - Gaps and windows use the absolute distance between `now` and each send, so a
//   caller whose clock runs a little behind or ahead still cannot slip under a limit.

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

// Entries older than this are dropped. windowHours is capped at this value,
// so no window can reach a record that has been pruned.
const RETENTION_MS = 30 * 24 * HOUR_MS;
const MAX_WINDOW_HOURS = RETENTION_MS / HOUR_MS;

// A lock held longer than this is treated as left behind by a crashed worker.
// Holds take a few milliseconds, so this has a wide margin.
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 5;

export const REASONS = Object.freeze({
  MIN_GAP: 'min_gap_not_elapsed',
  WINDOW_LIMIT: 'window_limit_reached',
});

const RESERVATION_ID_PATTERN = /^([0-9a-f]{64})\.[0-9a-f-]{36}$/;

/**
 * Asks for permission to send one message to one lead.
 * @param {{userId: string, maxPerWindow: number, windowHours: number, minGapMinutes: number}} request
 * @param {Date} now
 * @returns {Promise<{allowed: boolean, reason: string|null, reservationId: string|null}>}
 */
export async function reserve(request, now) {
  const req = validateRequest(request);
  const at = validateNow(now);
  const dir = stateDir();
  const key = leadKey(req.userId);
  const file = leadFile(dir, key);

  await ensureDirs(dir);
  return withLock(dir, key, async () => {
    const lead = (await readLead(file)) ?? { userId: req.userId, entries: [] };
    lead.entries = lead.entries.filter((e) => e.at >= at - RETENTION_MS);

    const active = lead.entries.filter((e) => e.status === 'active');
    const gapMs = req.minGapMinutes * MINUTE_MS;
    const windowMs = req.windowHours * HOUR_MS;

    if (active.some((e) => Math.abs(at - e.at) < gapMs)) {
      await writeLead(file, lead);
      return denied(REASONS.MIN_GAP);
    }

    const inWindow = active.filter((e) => Math.abs(at - e.at) < windowMs).length;
    if (inWindow >= req.maxPerWindow) {
      await writeLead(file, lead);
      return denied(REASONS.WINDOW_LIMIT);
    }

    const reservationId = `${key}.${randomUUID()}`;
    lead.entries.push({ id: reservationId, at, status: 'active' });
    await writeLead(file, lead);
    return { allowed: true, reason: null, reservationId };
  });
}

/**
 * Gives back a slot after the provider rejected the message. Works from any
 * process, because the state is on disk. Calling it twice is safe.
 * @param {string} reservationId
 * @returns {Promise<boolean>} true if a slot was freed, false if the id was unknown or already released
 */
export async function release(reservationId) {
  const match = RESERVATION_ID_PATTERN.exec(String(reservationId ?? ''));
  if (!match) return false;

  const dir = stateDir();
  const key = match[1];
  const file = leadFile(dir, key);

  await ensureDirs(dir);
  return withLock(dir, key, async () => {
    const lead = await readLead(file);
    const entry = lead?.entries.find((e) => e.id === reservationId);
    if (!entry || entry.status !== 'active') return false;

    entry.status = 'released';
    await writeLead(file, lead);
    return true;
  });
}

// ---------------------------------------------------------------------------

function denied(reason) {
  return { allowed: false, reason, reservationId: null };
}

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function leadKey(userId) {
  return createHash('sha256').update(userId).digest('hex');
}

function leadFile(dir, key) {
  return join(dir, 'leads', `${key}.json`);
}

async function ensureDirs(dir) {
  await mkdir(join(dir, 'leads'), { recursive: true });
  await mkdir(join(dir, 'locks'), { recursive: true });
}

function validateRequest(request) {
  if (!request || typeof request !== 'object') throw new TypeError('request must be an object');
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request;
  if (typeof userId !== 'string' || userId === '') throw new TypeError('userId must be a non-empty string');
  if (!Number.isInteger(maxPerWindow) || maxPerWindow < 1) throw new TypeError('maxPerWindow must be an integer >= 1');
  if (typeof windowHours !== 'number' || !(windowHours > 0 && windowHours <= MAX_WINDOW_HOURS)) {
    throw new TypeError(`windowHours must be > 0 and <= ${MAX_WINDOW_HOURS}`);
  }
  if (typeof minGapMinutes !== 'number' || !(minGapMinutes >= 0)) throw new TypeError('minGapMinutes must be >= 0');
  return { userId, maxPerWindow, windowHours, minGapMinutes };
}

function validateNow(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('now must be a valid Date');
  return now.getTime();
}

// Returns null when the lead has no file yet.
async function readLead(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Write to a temp file, then rename. Readers never see a half-written file.
async function writeLead(file, lead) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(lead));
  await rename(tmp, file);
}

async function withLock(dir, key, fn) {
  const lockPath = join(dir, 'locks', `${key}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      await breakIfStale(lockPath);
      if (Date.now() > deadline) throw new Error(`timed out waiting for limiter lock ${key}`);
      await sleep(LOCK_RETRY_MS * (1 + Math.random()));
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function breakIfStale(lockPath) {
  let mtimeMs;
  try {
    ({ mtimeMs } = await stat(lockPath));
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (Date.now() - mtimeMs < LOCK_STALE_MS) return;

  // rename is atomic, so only one worker can move a given stale lock aside.
  const aside = `${lockPath}.stale-${randomUUID()}`;
  try {
    await rename(lockPath, aside);
    await rm(aside, { recursive: true, force: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
