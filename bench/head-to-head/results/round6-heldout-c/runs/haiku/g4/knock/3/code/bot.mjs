// Proactive message limiter shared by several worker processes.
//
// Rule: one customer gets at most LIMIT proactive agent messages in any
// WINDOW_MS period, counted across sms, push and chat together.
//
// State lives in STATE_DIR/users/. Per customer there is one JSON file with
// the most recent LIMIT send times, and one lock directory. The lock is
// created with mkdir, which is atomic, so only one process at a time can
// read and update a customer's state. Different customers use different
// locks, so they never wait on each other.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rmdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const LIMIT = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const CHANNELS = new Set(['sms', 'push', 'chat']);
const LOCK_TIMEOUT_MS = 5000;
// A lock older than this is treated as left behind by a crashed process.
// Holders keep it only for a few milliseconds, so this is never reached in normal use.
const LOCK_STALE_MS = 5000;

export async function reserve(userId, channel, now) {
  if (typeof userId !== 'string' || userId === '') {
    throw new TypeError('userId must be a non-empty string');
  }
  if (!CHANNELS.has(channel)) {
    throw new TypeError('channel must be "sms", "push" or "chat"');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  const stateDir = process.env.STATE_DIR;
  if (!stateDir) {
    throw new Error('STATE_DIR environment variable is not set');
  }

  const usersDir = join(stateDir, 'users');
  await mkdir(usersDir, { recursive: true });

  // Hash the customer id so any string is safe as a file name.
  const key = createHash('sha256').update(userId).digest('hex');
  const file = join(usersDir, `${key}.json`);
  const lockDir = join(usersDir, `${key}.lock`);
  const nowMs = now.getTime();

  await acquireLock(lockDir);
  try {
    // Newest first. Only the newest LIMIT entries are kept. That is enough:
    // if fewer than LIMIT sends fall inside the window, all of them are stored.
    const sends = await loadSends(file);
    const cutoff = nowMs - WINDOW_MS;
    const inWindow = sends.filter((s) => s.t > cutoff);

    if (inWindow.length < LIMIT) {
      const updated = [{ t: nowMs, channel }, ...sends]
        .sort((a, b) => b.t - a.t)
        .slice(0, LIMIT);
      await saveSends(file, updated);
      return {
        allowed: true,
        retryAt: null,
        reason: `Allowed: this customer has ${inWindow.length + 1} of ${LIMIT} proactive messages in the last 24 hours across all channels.`,
      };
    }

    // The customer is at the limit. The window stops holding LIMIT sends
    // once the oldest of the LIMIT in-window sends is 24 hours old.
    const oldestCounted = inWindow[LIMIT - 1].t;
    const retryAt = new Date(oldestCounted + WINDOW_MS);
    return {
      allowed: false,
      retryAt,
      reason: `Blocked: this customer already received ${LIMIT} proactive agent messages in the last 24 hours across sms, push and chat together, so this ${channel} message was not sent.`,
    };
  } finally {
    await releaseLock(lockDir);
  }
}

async function loadSends(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  // A corrupt file must stop sending. Treating it as empty would let the limit be bypassed.
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.sends)) {
    throw new Error(`corrupt limiter state file: ${file}`);
  }
  return parsed.sends;
}

async function saveSends(file, sends) {
  // Write to a temporary file and rename it, so a reader never sees a partial file.
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify({ version: 1, sends }));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
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
        // Move the stale lock out of the way and try again.
        const graveyard = `${lockDir}.stale-${randomBytes(6).toString('hex')}`;
        await rename(lockDir, graveyard);
        await rm(graveyard, { recursive: true, force: true });
        continue;
      }
    } catch (err) {
      // The lock was released or removed while we checked it. Try again.
      if (err.code !== 'ENOENT') throw err;
      continue;
    }

    if (Date.now() > deadline) {
      // Fail closed: the caller must not send without a decision.
      throw new Error(`timed out waiting for limiter lock: ${lockDir}`);
    }
    await sleep(5 + Math.random() * 15);
  }
}

async function releaseLock(lockDir) {
  // If this fails, the lock stays until it goes stale. The send decision is already saved.
  await rmdir(lockDir).catch(() => {});
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
