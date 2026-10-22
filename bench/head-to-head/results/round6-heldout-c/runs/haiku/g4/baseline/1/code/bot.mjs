// Per-customer rate limit for proactive agent messages.
//
// Rule: one customer may receive at most LIMIT proactive messages in any
// rolling 24-hour window, counted across all channels together.
//
// Storage: one JSON file per customer in STATE_DIR, holding the timestamps
// (ms) of the messages that were allowed. Worker processes share only this
// directory, so every read-modify-write runs under a per-customer lock
// directory (mkdir is atomic on a local filesystem).

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LIMIT = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const CHANNELS = new Set(['sms', 'push', 'chat']);

const LOCK_STALE_MS = 10_000; // a lock older than this belonged to a crashed process
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_BASE_MS = 5;

/**
 * Decide whether one proactive message to `userId` may be sent now.
 * If allowed, the message is counted immediately.
 *
 * @param {string} userId
 * @param {'sms' | 'push' | 'chat'} channel
 * @param {Date} now
 * @returns {Promise<{allowed: boolean, retryAt: Date | null, reason: string}>}
 */
export async function reserve(userId, channel, now) {
  if (typeof userId !== 'string' || userId === '') {
    throw new TypeError('userId must be a non-empty string');
  }
  if (!CHANNELS.has(channel)) {
    throw new TypeError(`channel must be one of sms, push, chat (got ${String(channel)})`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }

  const dir = stateDir();
  await mkdir(dir, { recursive: true });

  const key = createHash('sha256').update(userId).digest('hex');
  const file = path.join(dir, `${key}.json`);
  const lockDir = path.join(dir, `${key}.lock`);
  const nowMs = now.getTime();

  return withLock(lockDir, async () => {
    // Keep only sends that are still inside the window for this call.
    const sends = (await readSends(file)).filter((s) => s.at > nowMs - WINDOW_MS);
    const count = sends.length;

    if (count < LIMIT) {
      sends.push({ at: nowMs, channel });
      sends.sort((a, b) => a.at - b.at);
      await writeSends(file, sends);
      return {
        allowed: true,
        retryAt: null,
        reason: `Allowed: this is proactive message ${count + 1} of ${LIMIT} for this customer in the last 24 hours.`,
      };
    }

    // Blocked. Sends expire oldest first, so we need (count - LIMIT + 1)
    // of them to expire before a new one fits. That is the element at index
    // count - LIMIT in the ascending list; it leaves the window at at + WINDOW_MS.
    const sorted = sends.map((s) => s.at).sort((a, b) => a - b);
    const retryAt = new Date(sorted[count - LIMIT] + WINDOW_MS);
    return {
      allowed: false,
      retryAt,
      reason:
        `Blocked: this customer already received ${LIMIT} proactive agent messages in the last 24 hours ` +
        `(limit ${LIMIT}, all channels combined). The next one can be sent after ${retryAt.toISOString()}.`,
    };
  });
}

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) {
    throw new Error('STATE_DIR environment variable is not set');
  }
  return dir;
}

// A missing file means no sends yet. A corrupt file throws, so the caller
// fails closed (no send) instead of guessing a count.
async function readSends(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return JSON.parse(text).sends;
}

// Write to a temp file and rename, so a crash never leaves a half-written file.
async function writeSends(file, sends) {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify({ sends }));
  await rename(tmp, file);
}

async function withLock(lockDir, fn) {
  await acquireLock(lockDir);
  try {
    return await fn();
  } finally {
    await rmdir(lockDir).catch(() => {});
  }
}

async function acquireLock(lockDir) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lockDir);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    await breakIfStale(lockDir);
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for lock ${lockDir}`);
    }
    await sleep(LOCK_RETRY_BASE_MS + Math.random() * LOCK_RETRY_BASE_MS);
  }
}

async function breakIfStale(lockDir) {
  try {
    const info = await stat(lockDir);
    if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
      await rm(lockDir, { recursive: true, force: true });
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
