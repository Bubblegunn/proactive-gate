// Proactive message gate: at most LIMIT agent messages per customer in any
// rolling WINDOW_MS, counted across all channels.
//
// Shared state lives in STATE_DIR, one file per customer, so worker processes
// on the same host see the same counts and the counts survive restarts.
// A per-customer lock directory (mkdir is atomic) serialises the
// read-check-write sequence across processes.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const LIMIT = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const CHANNELS = new Set(["sms", "push", "chat"]);

// The critical section takes milliseconds. A lock older than this belongs to a
// process that died while holding it, so it is removed.
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 15;

export async function reserve(userId, channel, now) {
  if (typeof userId !== "string" || userId === "") {
    throw new TypeError("userId must be a non-empty string");
  }
  if (!CHANNELS.has(channel)) {
    throw new TypeError('channel must be "sms", "push" or "chat"');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  const stateDir = process.env.STATE_DIR;
  if (!stateDir) {
    throw new Error("STATE_DIR environment variable is not set");
  }

  const usersDir = path.join(stateDir, "users");
  const locksDir = path.join(stateDir, "locks");
  await mkdir(usersDir, { recursive: true });
  await mkdir(locksDir, { recursive: true });

  // Hashing keeps arbitrary userId strings out of file names.
  const key = createHash("sha256").update(userId).digest("hex");
  const file = path.join(usersDir, `${key}.json`);
  const lock = path.join(locksDir, `${key}.lock`);

  await acquireLock(lock);
  try {
    const nowMs = now.getTime();
    // Sends at or before (now - WINDOW_MS) no longer count.
    const sends = (await readSends(file)).filter((s) => s.t > nowMs - WINDOW_MS);

    if (sends.length < LIMIT) {
      sends.push({ t: nowMs, channel });
      sends.sort((a, b) => a.t - b.t);
      await writeSends(file, sends);
      return {
        allowed: true,
        retryAt: null,
        reason: `Allowed: ${sends.length} of ${LIMIT} proactive messages used in the last 24 hours.`,
      };
    }

    // Sorted ascending. The send that must expire for a new one to fit is the
    // (count - LIMIT)-th oldest; it leaves the window at its time plus 24 hours.
    sends.sort((a, b) => a.t - b.t);
    const retryAt = new Date(sends[sends.length - LIMIT].t + WINDOW_MS);
    return {
      allowed: false,
      retryAt,
      reason:
        `Blocked: this customer already received ${LIMIT} proactive agent messages ` +
        `in the last 24 hours (limit ${LIMIT} per 24 hours, all channels combined). ` +
        `The next one is allowed at ${retryAt.toISOString()}.`,
    };
  } finally {
    await releaseLock(lock);
  }
}

async function readSends(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  // A corrupt file throws. reserve() then rejects, so the caller does not send.
  return JSON.parse(raw);
}

async function writeSends(file, sends) {
  // Write to a temp file and rename, so a reader never sees a partial file.
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(sends));
  await rename(tmp, file);
}

async function acquireLock(lock) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lock);
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }

    try {
      const info = await stat(lock);
      if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rmdir(lock);
        continue;
      }
    } catch (err) {
      // The holder released it between our mkdir and stat. Retry at once.
      if (err.code === "ENOENT") continue;
      throw err;
    }

    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for customer lock ${path.basename(lock)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
}

async function releaseLock(lock) {
  await rmdir(lock);
}
