// Shared per-lead send limiter. Every worker process calls reserve() before a
// send and release() if the provider rejects the message. State lives in
// STATE_DIR/leads, one JSON file per lead, guarded by a lock directory.
import { mkdir, readFile, writeFile, rename, rm, rmdir, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const MIN = 60_000;
const HOUR = 60 * MIN;
// Reservations older than this are dropped. windowHours must fit inside it.
const RETENTION_MS = 90 * 24 * HOUR;
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;

function leadsDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return path.join(dir, 'leads');
}

function validate(request, now) {
  if (!request || typeof request.userId !== 'string' || request.userId === '') {
    throw new TypeError('userId must be a non-empty string');
  }
  if (!Number.isInteger(request.maxPerWindow) || request.maxPerWindow < 1) {
    throw new TypeError('maxPerWindow must be an integer >= 1');
  }
  if (!(request.windowHours > 0) || request.windowHours * HOUR > RETENTION_MS) {
    throw new RangeError('windowHours must be > 0 and <= 2160');
  }
  if (!(request.minGapMinutes >= 0)) {
    throw new RangeError('minGapMinutes must be >= 0');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
}

// Fixed-length, filesystem-safe key for a lead id.
const keyOf = (userId) => createHash('sha256').update(userId).digest('hex');

// Mutual exclusion across processes. mkdir is atomic, so only one holder
// succeeds. A lock older than LOCK_STALE_MS is left by a crashed worker and is
// moved aside with a rename, which only one stealer can win.
async function withLock(lockDir, fn) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    try {
      const { mtimeMs } = await stat(lockDir);
      if (Date.now() - mtimeMs > LOCK_STALE_MS) {
        const aside = `${lockDir}.stale-${randomUUID()}`;
        await rename(lockDir, aside);
        await rm(aside, { recursive: true, force: true });
        continue;
      }
    } catch (err) {
      if (err.code === 'ENOENT') continue; // holder just released it
      throw err;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${lockDir}`);
    await new Promise((r) => setTimeout(r, 5 + Math.random() * 15));
  }
  try {
    return await fn();
  } finally {
    await rmdir(lockDir).catch(() => {});
  }
}

// A missing file means no history. A corrupt file throws, so the caller
// fails closed and sends nothing.
async function readRecords(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8')).reservations ?? [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// Temp file then rename, so a reader never sees a half-written file.
async function writeRecords(file, userId, reservations) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify({ userId, reservations }));
  await rename(tmp, file);
}

/**
 * Claim a send slot for one lead.
 * Counts every reservation that was not released, including ones whose send
 * outcome is unknown. Those may already have reached the recipient.
 * Reasons: min_gap_not_elapsed (a counted send is less than minGapMinutes away
 * in either direction), max_per_window_reached (maxPerWindow counted sends
 * fall in the last windowHours).
 */
export async function reserve(request, now) {
  validate(request, now);
  const dir = leadsDir();
  await mkdir(dir, { recursive: true });
  const key = keyOf(request.userId);
  const file = path.join(dir, `${key}.json`);
  const t = now.getTime();
  const windowMs = request.windowHours * HOUR;
  const gapMs = request.minGapMinutes * MIN;

  return withLock(path.join(dir, `${key}.lock`), async () => {
    const history = (await readRecords(file)).filter((r) => t - r.at <= RETENTION_MS);

    if (history.some((r) => Math.abs(t - r.at) < gapMs)) {
      await writeRecords(file, request.userId, history);
      return { allowed: false, reason: 'min_gap_not_elapsed', reservationId: null };
    }

    // Future-dated entries (a caller clock ahead of this one) also count.
    const inWindow = history.filter((r) => t - r.at < windowMs);
    if (inWindow.length >= request.maxPerWindow) {
      await writeRecords(file, request.userId, history);
      return { allowed: false, reason: 'max_per_window_reached', reservationId: null };
    }

    const reservationId = `${key}.${randomUUID()}`;
    history.push({ id: reservationId, at: t });
    await writeRecords(file, request.userId, history);
    return { allowed: true, reason: null, reservationId };
  });
}

/**
 * Give back a slot after the provider rejected the message.
 * Works from any process. Releasing an unknown, malformed or already released
 * id does nothing.
 */
export async function release(reservationId) {
  if (typeof reservationId !== 'string') return;
  const dot = reservationId.indexOf('.');
  const key = reservationId.slice(0, dot);
  if (dot < 0 || !/^[0-9a-f]{64}$/.test(key)) return;

  const dir = leadsDir();
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${key}.json`);
  await withLock(path.join(dir, `${key}.lock`), async () => {
    const history = await readRecords(file);
    const kept = history.filter((r) => r.id !== reservationId);
    if (kept.length !== history.length) {
      const userId = JSON.parse(await readFile(file, 'utf8')).userId;
      await writeRecords(file, userId, kept);
    }
  });
}
