// Per-customer cap on proactive agent messages, shared across worker processes.
//
// State lives in STATE_DIR:
//   <sha256(userId)>.json   { "sends": [{ "at": <epoch ms>, "channel": "sms" }, ...] }
//   locks/<sha256(userId)>.lock   directory used as a mutex (mkdir is atomic)
//
// Every reserve() call takes the customer's lock, reads the sends from the last
// 24 hours, decides, writes the new state, and releases the lock. Different
// customers use different locks, so they never wait on each other.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rmdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const WINDOW_MS = 24 * 60 * 60 * 1000;
const LIMIT = 5;
const CHANNELS = new Set(["sms", "push", "chat"]);

// A lock older than this is treated as left behind by a crashed process.
// Locks are held for a few milliseconds, so this is far above normal use.
const LOCK_STALE_MS = 5000;
const LOCK_TIMEOUT_MS = 10000;
const LOCK_RETRY_MS = 5;

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR environment variable is not set");
  return dir;
}

async function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lockPath);
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }

    try {
      const info = await stat(lockPath);
      if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        // Move the stale lock aside, then delete it. If another process already
        // moved it, the rename fails and the loop simply tries again.
        const aside = `${lockPath}.stale-${randomUUID()}`;
        try {
          await rename(lockPath, aside);
          await rm(aside, { recursive: true, force: true });
        } catch (renameErr) {
          if (renameErr.code !== "ENOENT") throw renameErr;
        }
        continue;
      }
    } catch (err) {
      // The lock was released between our mkdir and stat calls.
      if (err.code !== "ENOENT") throw err;
      continue;
    }

    if (Date.now() > deadline) {
      // Fail closed: the caller gets an exception and must not send.
      throw new Error(`timed out waiting for limiter lock ${lockPath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
}

async function releaseLock(lockPath) {
  await rmdir(lockPath);
}

async function readSends(file) {
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(data.sends) ? data.sends : [];
  } catch (err) {
    // No file yet means no sends. A corrupt file throws, so the caller fails closed.
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function writeSends(file, sends) {
  // Write to a temp file, flush it to disk, then rename it over the old file,
  // so a crash never leaves a half-written state file.
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(JSON.stringify({ sends }));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
}

/**
 * Decide whether one proactive agent message to a customer may be sent now.
 *
 * @param {string} userId   customer id
 * @param {"sms"|"push"|"chat"} channel
 * @param {Date} now        current instant, supplied by the caller
 * @returns {Promise<{allowed: boolean, retryAt: Date|null, reason: string}>}
 *   If allowed, the send is already counted. If not, nothing is counted.
 */
export async function reserve(userId, channel, now) {
  if (typeof userId !== "string" || userId === "") {
    throw new TypeError("userId must be a non-empty string");
  }
  if (!CHANNELS.has(channel)) {
    throw new TypeError(`channel must be "sms", "push" or "chat"; got ${String(channel)}`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }

  const dir = stateDir();
  const locksDir = join(dir, "locks");
  await mkdir(locksDir, { recursive: true });

  const key = createHash("sha256").update(userId).digest("hex");
  const file = join(dir, `${key}.json`);
  const lockPath = join(locksDir, `${key}.lock`);
  const nowMs = now.getTime();

  await acquireLock(lockPath);
  try {
    const sends = (await readSends(file))
      .filter((send) => send.at > nowMs - WINDOW_MS)
      .sort((a, b) => a.at - b.at);

    if (sends.length < LIMIT) {
      sends.push({ at: nowMs, channel });
      await writeSends(file, sends);
      return {
        allowed: true,
        retryAt: null,
        reason: `Allowed: ${sends.length} of ${LIMIT} proactive messages used in the last 24 hours.`,
      };
    }

    // Sends are sorted oldest first. The customer drops below the limit once
    // enough of the oldest sends leave the 24-hour window, which is when the
    // (count - LIMIT)th oldest send is 24 hours old.
    const retryAt = new Date(sends[sends.length - LIMIT].at + WINDOW_MS);
    return {
      allowed: false,
      retryAt,
      reason:
        `Blocked: this customer already received ${sends.length} proactive agent messages ` +
        `in the last 24 hours across all channels (limit ${LIMIT}). ` +
        `The next one can be sent at ${retryAt.toISOString()}.`,
    };
  } finally {
    await releaseLock(lockPath);
  }
}
