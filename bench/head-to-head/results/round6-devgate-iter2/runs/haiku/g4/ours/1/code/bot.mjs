// Shared outbound rate limiter for lead texts (WhatsApp/SMS).
// Every worker calls reserve() before sending and release() if the provider
// rejects the message. State lives in STATE_DIR, one JSON file per lead, so
// all worker processes see the same history and it survives restarts.
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const HOUR_MS = 3600_000;
const MINUTE_MS = 60_000;
const LOCK_STALE_MS = 5_000; // a lock older than this belonged to a crashed worker
const LOCK_RETRY_MS = 5; // base wait between lock attempts (plus up to 5 ms jitter)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function userKey(userId) {
  return createHash('sha256').update(userId).digest('hex');
}

function validate(request) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request ?? {};
  if (typeof userId !== 'string' || userId === '') throw new TypeError('userId must be a non-empty string');
  if (!Number.isInteger(maxPerWindow) || maxPerWindow < 0) throw new TypeError('maxPerWindow must be an integer >= 0');
  if (!Number.isFinite(windowHours) || windowHours <= 0) throw new TypeError('windowHours must be a number > 0');
  if (!Number.isFinite(minGapMinutes) || minGapMinutes < 0) throw new TypeError('minGapMinutes must be a number >= 0');
  return { userId, maxPerWindow, windowMs: windowHours * HOUR_MS, gapMs: minGapMinutes * MINUTE_MS };
}

function toMs(now) {
  const ms = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(ms)) throw new TypeError('now must be a valid Date');
  return ms;
}

// Mkdir is atomic, so only one worker can hold the lock for a lead at a time.
// Different leads use different locks and never wait on each other.
async function withLeadLock(dir, key, fn) {
  const locks = path.join(dir, 'locks');
  await mkdir(locks, { recursive: true });
  const lockPath = path.join(locks, `${key}.lock`);
  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const { mtimeMs } = await stat(lockPath);
        if (Date.now() - mtimeMs > LOCK_STALE_MS) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statErr) {
        if (statErr.code !== 'ENOENT') throw statErr;
        continue; // lock was released between mkdir and stat
      }
      await sleep(LOCK_RETRY_MS + Math.random() * LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

// A missing file is an empty history. A corrupt file throws, so the caller
// fails closed and does not send.
async function readRecord(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { entries: [], retainMs: 0 };
    throw err;
  }
  return JSON.parse(text);
}

// Write to a temp file, then rename, so readers never see a half-written record.
async function writeRecord(file, record) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(record));
  await rename(tmp, file);
}

// Claims one send slot for one lead. A slot counts from the moment it is
// reserved until it is released; refused requests never count, because the
// lead receives nothing from them.
export async function reserve(request, now) {
  const { userId, maxPerWindow, windowMs, gapMs } = validate(request);
  const nowMs = toMs(now);
  const dir = stateDir();
  const key = userKey(userId);
  const file = path.join(dir, 'users', `${key}.json`);
  await mkdir(path.join(dir, 'users'), { recursive: true });

  return withLeadLock(dir, key, async () => {
    const rec = await readRecord(file);
    // Keep history as long as the longest window or gap any caller has used.
    const retainMs = Math.max(rec.retainMs ?? 0, windowMs, gapMs);
    const entries = rec.entries.filter((e) => e.at > nowMs - retainMs);
    const inWindow = entries.filter((e) => e.at > nowMs - windowMs).length;
    const lastAt = entries.reduce((max, e) => Math.max(max, e.at), -Infinity);

    let reason = null;
    if (inWindow >= maxPerWindow) reason = 'window_limit';
    else if (nowMs - lastAt < gapMs) reason = 'min_gap';

    if (reason) return { allowed: false, reason, reservationId: null };

    const reservationId = `${key}_${randomUUID()}`;
    entries.push({ id: reservationId, at: nowMs });
    await writeRecord(file, { entries, retainMs });
    return { allowed: true, reason: null, reservationId };
  });
}

// Gives a slot back after the provider rejected the message. The reservation
// id carries the lead key, so any worker can find the record. Releasing an
// unknown or already-released id does nothing.
export async function release(reservationId) {
  if (typeof reservationId !== 'string') return { released: false };
  const sep = reservationId.indexOf('_');
  const key = reservationId.slice(0, sep);
  if (sep !== 64 || !/^[0-9a-f]{64}$/.test(key)) return { released: false };

  const dir = stateDir();
  const file = path.join(dir, 'users', `${key}.json`);
  return withLeadLock(dir, key, async () => {
    let rec;
    try {
      rec = await readRecord(file);
    } catch (err) {
      if (err.code === 'ENOENT') return { released: false };
      throw err;
    }
    const entries = rec.entries.filter((e) => e.id !== reservationId);
    if (entries.length === rec.entries.length) return { released: false };
    await writeRecord(file, { entries, retainMs: rec.retainMs });
    return { released: true };
  });
}
