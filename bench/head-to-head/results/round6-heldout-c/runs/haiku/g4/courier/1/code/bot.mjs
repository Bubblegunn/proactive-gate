// Proactive message limiter shared by several worker processes.
//
// Rule: one customer gets at most LIMIT proactive agent messages in any
// rolling 24-hour window, counted across all channels together.
//
// State lives in STATE_DIR, one JSON file per customer, so the limit survives
// restarts and is shared by every process that uses the same directory.
// A short per-customer lock (a directory created with mkdir, which is atomic)
// makes "check the count, then record the send" a single step, so two
// processes handling the same customer at the same moment cannot both pass.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const LIMIT = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const CHANNELS = new Set(['sms', 'push', 'chat']);

// A lock older than this is assumed to belong to a crashed process.
const STALE_LOCK_MS = 10_000;
const LOCK_RETRY_MS = 5;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(lockPath) {
  for (;;) {
    try {
      await fs.mkdir(lockPath);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    try {
      const { mtimeMs } = await fs.stat(lockPath);
      if (Date.now() - mtimeMs > STALE_LOCK_MS) {
        await fs.rm(lockPath, { recursive: true, force: true });
        continue;
      }
    } catch (err) {
      // The holder released the lock between our mkdir and stat; just retry.
      if (err.code !== 'ENOENT') throw err;
      continue;
    }
    await sleep(LOCK_RETRY_MS);
  }
}

async function releaseLock(lockPath) {
  await fs.rm(lockPath, { recursive: true, force: true });
}

async function readSends(statePath) {
  let raw;
  try {
    raw = await fs.readFile(statePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  // A corrupt file is not treated as empty: that would silently reset the
  // limit for this customer. Fail loudly instead.
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.sends) || !parsed.sends.every(Number.isFinite)) {
    throw new Error(`Malformed limiter state file: ${statePath}`);
  }
  return parsed.sends;
}

async function writeSends(statePath, sends) {
  const tmpPath = `${statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify({ sends }));
  // rename is atomic on POSIX, so readers never see a half-written file.
  await fs.rename(tmpPath, statePath);
}

/**
 * Decide whether one proactive agent message to a customer may be sent now.
 *
 * If allowed, the send is recorded immediately, so the caller must send.
 * If not allowed, nothing is recorded.
 *
 * @param {string} userId
 * @param {'sms'|'push'|'chat'} channel
 * @param {Date} now
 * @returns {Promise<{allowed: boolean, retryAt: Date|null, reason: string}>}
 */
export async function reserve(userId, channel, now) {
  if (typeof userId !== 'string' || userId === '') {
    throw new TypeError('userId must be a non-empty string');
  }
  if (!CHANNELS.has(channel)) {
    throw new TypeError(`channel must be one of sms, push, chat; got ${String(channel)}`);
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  const stateDir = process.env.STATE_DIR;
  if (!stateDir) {
    throw new Error('STATE_DIR environment variable is not set');
  }

  const nowMs = now.getTime();
  const key = crypto.createHash('sha256').update(userId).digest('hex');
  const usersDir = path.join(stateDir, 'users');
  const locksDir = path.join(stateDir, 'locks');
  const statePath = path.join(usersDir, `${key}.json`);
  const lockPath = path.join(locksDir, `${key}.lock`);

  await fs.mkdir(usersDir, { recursive: true });
  await fs.mkdir(locksDir, { recursive: true });

  await acquireLock(lockPath);
  try {
    // A send at time t counts while now < t + WINDOW_MS, so entries with
    // t <= now - WINDOW_MS have expired.
    const sends = (await readSends(statePath))
      .filter((t) => t > nowMs - WINDOW_MS)
      .sort((a, b) => a - b);

    if (sends.length < LIMIT) {
      sends.push(nowMs);
      await writeSends(statePath, sends);
      return { allowed: true, retryAt: null, reason: 'Within the limit.' };
    }

    // Count is at the limit. The send becomes allowed once enough old entries
    // expire: the entry at index (count - LIMIT) is the one whose expiry
    // brings the count below LIMIT.
    const expiring = sends[sends.length - LIMIT];
    const retryAt = new Date(expiring + WINDOW_MS);
    const reason =
      `Customer already received ${LIMIT} proactive agent messages in the last 24 hours ` +
      `(limit is ${LIMIT} per 24 hours across sms, push and chat), so this ${channel} message was not sent; ` +
      `the next one can be sent after ${retryAt.toISOString()}.`;
    return { allowed: false, retryAt, reason };
  } finally {
    await releaseLock(lockPath);
  }
}
