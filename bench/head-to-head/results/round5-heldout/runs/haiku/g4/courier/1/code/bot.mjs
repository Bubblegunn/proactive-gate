// Shared send-rate limiter for proactive lead messages.
//
// Every worker process on the machine calls reserve() before sending and
// release() if the provider rejects the message. State lives in STATE_DIR so
// it survives restarts and is shared by all workers.
//
// Layout under STATE_DIR:
//   leads/<sha256(userId)>.json  one history file per lead: { retentionMs, sends: [{ id, at }] }
//   locks/<sha256(userId)>.lock  lock directory (mkdir is atomic) held during read-modify-write
//
// What counts as a send: every reservation that was allowed and not released.
// A reservation that is never released (worker crashed mid-send) still counts,
// because the message may have reached the lead.
//
// Limits:
//   per_window_limit  sliding window: fewer than maxPerWindow counted sends in the
//                     last windowHours. A rolling window is what the recipient
//                     experiences: any windowHours span holds at most maxPerWindow.
//   min_gap           no counted send within minGapMinutes of now, on either side.
//
// Failures (bad input, corrupt state, lock timeout) throw. Callers must treat a
// throw as "not sent" and must not send.

import { mkdir, readFile, rename, rm, stat, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const LOCK_WAIT_MS = 10_000;
const STALE_LOCK_MS = 15_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const RESERVATION_ID = /^([0-9a-f]{64})\.[0-9a-f-]{36}$/;

export async function reserve(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = validateRequest(request);
  const nowMs = validateNow(now);
  const dir = stateDir();
  const key = leadKey(userId);
  const windowMs = windowHours * HOUR_MS;
  const gapMs = minGapMinutes * MINUTE_MS;

  await ensureDirs(dir);
  return withLead(dir, key, async () => {
    const file = leadFile(dir, key);
    const history = await loadHistory(file);
    // Keep records as long as any window or gap seen so far could still need them.
    const retentionMs = Math.max(history.retentionMs ?? 0, windowMs, gapMs);
    const sends = history.sends.filter((s) => s.at >= nowMs - retentionMs);

    const countInWindow = sends.filter((s) => s.at > nowMs - windowMs).length;
    if (countInWindow >= maxPerWindow) {
      return { allowed: false, reason: 'per_window_limit', reservationId: null };
    }
    if (sends.some((s) => Math.abs(nowMs - s.at) < gapMs)) {
      return { allowed: false, reason: 'min_gap', reservationId: null };
    }

    const reservationId = `${key}.${randomUUID()}`;
    sends.push({ id: reservationId, at: nowMs });
    await saveHistory(file, { retentionMs, sends });
    return { allowed: true, reason: null, reservationId };
  });
}

export async function release(reservationId) {
  const match = RESERVATION_ID.exec(typeof reservationId === 'string' ? reservationId : '');
  if (!match) return false;
  const key = match[1];
  const dir = stateDir();
  await ensureDirs(dir);
  return withLead(dir, key, async () => {
    const file = leadFile(dir, key);
    const history = await loadHistory(file);
    const sends = history.sends.filter((s) => s.id !== reservationId);
    if (sends.length === history.sends.length) return false;
    await saveHistory(file, { retentionMs: history.retentionMs, sends });
    return true;
  });
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
  return path.join(dir, 'leads', `${key}.json`);
}

async function ensureDirs(dir) {
  await mkdir(path.join(dir, 'leads'), { recursive: true });
  await mkdir(path.join(dir, 'locks'), { recursive: true });
}

function validateRequest(request) {
  if (request === null || typeof request !== 'object') {
    throw new TypeError('request must be an object');
  }
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request;
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new TypeError('userId must be a non-empty string');
  }
  if (!Number.isInteger(maxPerWindow) || maxPerWindow < 0) {
    throw new TypeError('maxPerWindow must be an integer >= 0');
  }
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    throw new TypeError('windowHours must be a finite number > 0');
  }
  if (!Number.isFinite(minGapMinutes) || minGapMinutes < 0) {
    throw new TypeError('minGapMinutes must be a finite number >= 0');
  }
  return { userId, maxPerWindow, windowHours, minGapMinutes };
}

function validateNow(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  return now.getTime();
}

// Runs fn while holding the lock for one lead. Other leads are not blocked.
async function withLead(dir, key, fn) {
  const lockDir = path.join(dir, 'locks', `${key}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      await breakIfStale(lockDir);
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for lock on lead ${key}`);
      }
      await sleep(5 + Math.random() * 15);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

// A worker that died while holding the lock leaves the directory behind.
// Rename it aside first so that only one breaker succeeds.
async function breakIfStale(lockDir) {
  let info;
  try {
    info = await stat(lockDir);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (Date.now() - info.mtimeMs < STALE_LOCK_MS) return;
  const graveyard = `${lockDir}.stale-${randomUUID()}`;
  try {
    await rename(lockDir, graveyard);
    await rm(graveyard, { recursive: true, force: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function loadHistory(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { retentionMs: 0, sends: [] };
    throw err;
  }
  const history = JSON.parse(text);
  if (!Array.isArray(history.sends)) {
    throw new Error(`corrupt rate-limit state: ${file}`);
  }
  return history;
}

// Write to a temp file, fsync, then rename, so readers never see a partial file.
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
