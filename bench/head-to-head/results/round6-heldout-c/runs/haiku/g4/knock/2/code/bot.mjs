// Per-customer rate limit for proactive agent messages.
//
// Rule: no customer receives more than LIMIT proactive messages in any
// rolling WINDOW_MS period, counted across all channels together.
//
// State lives in STATE_DIR, one JSON file per customer, so that several
// worker processes on the same server share one count. Each customer has a
// lock directory; mkdir is atomic, so only one process at a time reads and
// updates a given customer's file. Different customers use different locks
// and never wait on each other.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const LIMIT = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const CHANNELS = new Set(['sms', 'push', 'chat']);

// The lock is held for milliseconds. A lock older than LOCK_STALE_MS is
// assumed to belong to a process that crashed while holding it.
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 15_000;

/**
 * Decide whether a proactive message to `userId` on `channel` may be sent now.
 *
 * If allowed, the send is counted immediately. If not allowed, nothing is
 * counted.
 *
 * @param {string} userId
 * @param {'sms' | 'push' | 'chat'} channel
 * @param {Date} now the current instant
 * @returns {Promise<{ allowed: boolean, retryAt: Date | null, reason: string }>}
 */
export async function reserve(userId, channel, now) {
  if (typeof userId !== 'string' || userId === '') {
    throw new TypeError('userId must be a non-empty string');
  }
  if (!CHANNELS.has(channel)) {
    throw new TypeError(`channel must be one of sms, push, chat; got ${String(channel)}`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }

  const dir = process.env.STATE_DIR;
  if (!dir) {
    throw new Error('STATE_DIR environment variable is not set');
  }
  await mkdir(dir, { recursive: true });

  const key = createHash('sha256').update(userId).digest('hex');
  const dataFile = join(dir, `${key}.json`);
  const lockDir = join(dir, `${key}.lock`);
  const t = now.getTime();

  await acquireLock(lockDir);
  try {
    // Keep only sends that are still inside the window. A send at time s
    // counts for a check at time t while s > t - WINDOW_MS.
    const sent = (await readSent(dataFile))
      .filter((s) => s > t - WINDOW_MS)
      .sort((a, b) => a - b);

    if (sent.length < LIMIT) {
      sent.push(t);
      await writeSent(dataFile, sent);
      return {
        allowed: true,
        retryAt: null,
        reason: `Allowed: ${sent.length} of ${LIMIT} proactive messages used in the last 24 hours.`,
      };
    }

    // The next send becomes possible when enough old sends have left the
    // window. With LIMIT sends in the window, that is when the oldest one
    // expires.
    const expiring = sent[sent.length - LIMIT];
    const retryAt = new Date(expiring + WINDOW_MS);
    return {
      allowed: false,
      retryAt,
      reason: `Blocked: this customer already received ${LIMIT} proactive messages in the last 24 hours (the limit applies across sms, push and chat together). The next one can be sent after ${retryAt.toISOString()}.`,
    };
  } finally {
    await releaseLock(lockDir);
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

    try {
      const info = await stat(lockDir);
      if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
    } catch (err) {
      // The lock was released between our mkdir and stat. Try again.
      if (err.code === 'ENOENT') continue;
      throw err;
    }

    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for lock ${lockDir}`);
    }
    await sleep(5 + Math.random() * 15);
  }
}

function releaseLock(lockDir) {
  return rm(lockDir, { recursive: true, force: true });
}

async function readSent(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  // A corrupt file fails closed: the call throws and nothing is sent.
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`rate-limit state file ${file} is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(data.sent) || !data.sent.every(Number.isFinite)) {
    throw new Error(`rate-limit state file ${file} has an unexpected shape`);
  }
  return data.sent;
}

async function writeSent(file, sent) {
  // Write to a temporary file and rename it, so a crash never leaves a
  // half-written state file behind.
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify({ sent }));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
