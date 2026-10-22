import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

// Product limit: at most 5 proactive agent messages per customer in any
// rolling 24-hour window, counted across sms, push and chat together.
const LIMIT = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const CHANNELS = new Set(["sms", "push", "chat"]);

// Worker processes share only STATE_DIR. Coordination is a per-customer lock
// file created with O_EXCL ("wx"), which is atomic across processes on one host.
const LOCK_TIMEOUT_MS = 5000;
// A lock older than this is left behind by a crashed process and is removed.
// The critical section is a few milliseconds, so this is far above normal hold time.
const LOCK_STALE_MS = 10000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function breakIfStale(lockPath) {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
      await unlink(lockPath);
    }
  } catch (err) {
    // Lock was released or replaced between checks; the caller retries.
    if (err.code !== "ENOENT") throw err;
  }
}

async function withLock(lockPath, fn) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    let handle;
    try {
      handle = await open(lockPath, "wx");
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      await breakIfStale(lockPath);
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for lock ${lockPath}`);
      }
      await sleep(5 + Math.random() * 15);
      continue;
    }
    await handle.close();
    try {
      return await fn();
    } finally {
      await unlink(lockPath).catch(() => {});
    }
  }
}

function stateFileFor(stateDir, userId) {
  // Hash the id so arbitrary user ids cannot escape the state directory.
  const hash = createHash("sha256").update(userId).digest("hex");
  return path.join(stateDir, "users", `${hash}.json`);
}

// Returns the timestamps (epoch ms, ascending) of the most recent allowed sends.
// A missing file means no sends. A corrupt file throws, so counts are never
// silently reset; the caller then fails closed and sends nothing.
async function readSends(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const data = JSON.parse(text);
  if (!Array.isArray(data.sends)) {
    throw new Error(`Malformed state file ${file}`);
  }
  return data.sends;
}

async function writeSends(file, sends) {
  // Write to a temp file, flush it, then rename. Readers never see a partial file.
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
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
 * Decide whether a proactive agent message to this customer may be sent now.
 *
 * @param {string} userId
 * @param {"sms" | "push" | "chat"} channel
 * @param {Date} now
 * @returns {Promise<{allowed: boolean, retryAt: Date | null, reason: string}>}
 */
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

  await mkdir(path.join(stateDir, "users"), { recursive: true });
  const file = stateFileFor(stateDir, userId);
  const nowMs = now.getTime();

  return withLock(`${file}.lock`, async () => {
    // Only the LIMIT newest sends are stored. If the window holds fewer than
    // LIMIT of them, the stored list is complete for this decision.
    const sends = (await readSends(file)).slice(-LIMIT);
    const inWindow = sends.filter((t) => t > nowMs - WINDOW_MS);

    if (inWindow.length < LIMIT) {
      const updated = [...sends, nowMs].sort((a, b) => a - b).slice(-LIMIT);
      await writeSends(file, updated);
      return {
        allowed: true,
        retryAt: null,
        reason: `Allowed: ${inWindow.length + 1} of ${LIMIT} proactive messages used in the last 24 hours.`,
      };
    }

    // Denied. A new send becomes possible when the oldest of the LIMIT
    // in-window sends falls out of the window.
    const retryAt = new Date(inWindow[0] + WINDOW_MS);
    return {
      allowed: false,
      retryAt,
      reason: `Customer ${userId} already received ${LIMIT} proactive agent messages in the last 24 hours (limit is ${LIMIT} per 24 hours across all channels), so this ${channel} message was not sent; the next one can go out at ${retryAt.toISOString()}.`,
    };
  });
}
