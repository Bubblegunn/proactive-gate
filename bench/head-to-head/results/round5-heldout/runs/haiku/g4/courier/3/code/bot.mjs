// Shared per-lead send rate limiter for many worker processes on one machine.
//
// State lives under STATE_DIR:
//   leads/<sha256(userId)>.json   accepted-or-pending sends for one lead
//   locks/<sha256(userId)>.lock/  mkdir-based mutex, one per lead
//
// What counts: a slot is consumed when reserve() allows a send, and it is
// given back only by release(). A reservation whose worker crashed before
// release() still counts, because the message may have reached the lead.
// Refused attempts never count: the lead received nothing.
//
// Window: a rolling window of windowHours ending at `now`, not a calendar day.
// A recipient experiences "N messages in any 24 hours", so that is what we cap.
//
// Limits are per lead (userId), across WhatsApp and SMS: the same person
// sees both channels.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';

const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 10000; // a holder keeps the lock for milliseconds; older means it crashed
const RETENTION_MS = 365 * 24 * 3600 * 1000; // windows longer than this are rejected
const MAX_WINDOW_HOURS = RETENTION_MS / 3600000;
const RESERVATION_ID = /^([0-9a-f]{64})\.[0-9a-f-]{36}$/;

export async function reserve(request, now) {
  const req = validateRequest(request, now);
  const key = keyFor(req.userId);

  return withLock(key, async () => {
    const state = (await readLead(key)) ?? { userId: req.userId, sends: [] };
    state.sends = state.sends.filter((s) => req.nowMs - s.at < RETENTION_MS);

    const windowStart = req.nowMs - req.windowHours * 3600000;
    const inWindow = state.sends.filter((s) => s.at > windowStart);
    if (inWindow.length >= req.maxPerWindow) {
      return refused('window_limit_reached');
    }

    if (req.minGapMs > 0 && state.sends.length > 0) {
      const latest = Math.max(...state.sends.map((s) => s.at));
      // A negative difference (latest is in the caller's future) also refuses: conservative under clock skew.
      if (req.nowMs - latest < req.minGapMs) {
        return refused('min_gap_not_elapsed');
      }
    }

    const reservationId = `${key}.${randomUUID()}`;
    state.sends.push({ id: reservationId, at: req.nowMs });
    await writeLead(key, state);
    return { allowed: true, reason: null, reservationId };
  });
}

export async function release(reservationId) {
  const match = typeof reservationId === 'string' ? RESERVATION_ID.exec(reservationId) : null;
  if (!match) return false;
  const key = match[1];

  return withLock(key, async () => {
    const state = await readLead(key);
    if (!state) return false;
    const idx = state.sends.findIndex((s) => s.id === reservationId);
    if (idx < 0) return false; // already released, or pruned
    state.sends.splice(idx, 1);
    await writeLead(key, state);
    return true;
  });
}

function refused(reason) {
  return { allowed: false, reason, reservationId: null };
}

function validateRequest(request, now) {
  if (!request || typeof request !== 'object') throw new TypeError('request must be an object');
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request;
  if (typeof userId !== 'string' || userId === '') throw new TypeError('userId must be a non-empty string');
  if (!Number.isInteger(maxPerWindow) || maxPerWindow < 0) throw new TypeError('maxPerWindow must be an integer >= 0');
  if (!(Number.isFinite(windowHours) && windowHours > 0 && windowHours <= MAX_WINDOW_HOURS)) {
    throw new RangeError(`windowHours must be > 0 and <= ${MAX_WINDOW_HOURS}`);
  }
  if (!(Number.isFinite(minGapMinutes) && minGapMinutes >= 0)) throw new TypeError('minGapMinutes must be >= 0');

  const nowMs = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(nowMs)) throw new TypeError('now must be a valid Date');

  return { userId, maxPerWindow, windowHours, minGapMs: minGapMinutes * 60000, nowMs };
}

function stateRoot() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return path.resolve(dir);
}

function keyFor(userId) {
  return createHash('sha256').update(userId).digest('hex');
}

async function readLead(key) {
  let text;
  try {
    text = await readFile(path.join(stateRoot(), 'leads', `${key}.json`), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  // Writes are atomic (temp file + rename), so a parse error means real damage.
  // Throw rather than treat the history as empty, which would let sends through.
  return JSON.parse(text);
}

async function writeLead(key, state) {
  const file = path.join(stateRoot(), 'leads', `${key}.json`);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(state));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

async function withLock(key, fn) {
  const root = stateRoot();
  await mkdir(path.join(root, 'leads'), { recursive: true });
  await mkdir(path.join(root, 'locks'), { recursive: true });
  const lockDir = path.join(root, 'locks', `${key}.lock`);

  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lockDir); // atomic: exactly one process succeeds
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      await removeIfStale(lockDir);
      if (Date.now() > deadline) throw new Error(`timed out waiting for rate limiter lock ${key.slice(0, 12)}`);
      await sleep(5 + Math.random() * 20);
    }
  }

  try {
    return await fn();
  } finally {
    await rmdir(lockDir).catch((err) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
}

async function removeIfStale(lockDir) {
  let info;
  try {
    info = await stat(lockDir);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
    await rmdir(lockDir).catch((err) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
