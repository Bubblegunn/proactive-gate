// Per-customer cap on proactive agent messages: at most LIMIT messages in any
// rolling WINDOW_MS period, counted across all channels together.
//
// State lives in STATE_DIR, one JSON file per customer, so customers never
// touch each other's data or locks. Worker processes coordinate through a
// mkdir-based lock (mkdir is atomic on POSIX), held only for a read-modify-write
// of one customer's file.
//
// Window rule: a send at time t is refused when LIMIT sends already fall in
// the closed interval [t - WINDOW_MS, t]. This is the stricter reading of
// "any 24-hour period", so a set of sends spanning exactly 24h also counts.

import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

const LIMIT = 5;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const CHANNELS = new Set(["sms", "push", "chat"]);

const LOCK_STALE_MS = 10_000; // a lock older than this came from a crashed process
const LOCK_WAIT_MS = 15_000; // give up and fail closed after this long
const LOCK_RETRY_MS = 5;

function stateRoot() {
  const dir = process.env.STATE_DIR;
  if (!dir) {
    throw new Error("STATE_DIR environment variable is not set");
  }
  return path.join(dir, "proactive-reserve");
}

function fileNames(root, userId) {
  const key = crypto.createHash("sha256").update(userId, "utf8").digest("hex");
  return {
    data: path.join(root, `${key}.json`),
    lock: path.join(root, `${key}.lock`),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function acquireLock(lockDir) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await fs.mkdir(lockDir);
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }

    try {
      const stat = await fs.stat(lockDir);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await fs.rmdir(lockDir);
        continue;
      }
    } catch (err) {
      // The holder released it between our mkdir and stat; just retry.
      if (err.code !== "ENOENT") throw err;
    }

    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the reservation lock");
    }
    await sleep(LOCK_RETRY_MS);
  }
}

async function releaseLock(lockDir) {
  await fs.rmdir(lockDir).catch((err) => {
    if (err.code !== "ENOENT") throw err;
  });
}

async function readSends(dataFile) {
  let raw;
  try {
    raw = await fs.readFile(dataFile, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.sends) ? parsed.sends : [];
}

async function writeSends(dataFile, sends) {
  // Write to a temp file, fsync it, then rename over the old file. A crash
  // leaves either the old state or the new state, never a half-written file.
  const tmp = `${dataFile}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const handle = await fs.open(tmp, "w");
  try {
    await handle.writeFile(JSON.stringify({ sends }));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, dataFile);
}

function formatTime(ms) {
  return new Date(ms).toISOString();
}

/**
 * Decide whether one proactive message to one customer may be sent now.
 * If allowed, the send is counted immediately; the caller must send right after.
 *
 * @param {string} userId
 * @param {"sms" | "push" | "chat"} channel
 * @param {Date} now
 * @returns {Promise<{allowed: boolean, retryAt: Date | null, reason: string}>}
 */
export async function reserve(userId, channel, now) {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new TypeError("userId must be a non-empty string");
  }
  if (!CHANNELS.has(channel)) {
    throw new TypeError(`channel must be one of sms, push, chat (got ${String(channel)})`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }

  const nowMs = now.getTime();
  const root = stateRoot();
  await fs.mkdir(root, { recursive: true });
  const { data, lock } = fileNames(root, userId);

  await acquireLock(lock);
  try {
    // Keep only sends that can still fall inside a window ending at nowMs.
    const windowStart = nowMs - WINDOW_MS;
    const sends = (await readSends(data))
      .filter((t) => t >= windowStart)
      .sort((a, b) => a - b);

    if (sends.length < LIMIT) {
      sends.push(nowMs);
      await writeSends(data, sends);
      return { allowed: true, retryAt: null, reason: "" };
    }

    // The send is refused. The next one can go once enough old sends have
    // left the window: the (count - LIMIT)th oldest send is the one whose
    // expiry frees the slot. It leaves when a window ending at t no longer
    // reaches it, i.e. when t > sendTime + WINDOW_MS.
    const blocking = sends[sends.length - LIMIT];
    const retryMs = blocking + WINDOW_MS + 1;
    await writeSends(data, sends); // persist the pruned list

    return {
      allowed: false,
      retryAt: new Date(retryMs),
      reason:
        `This customer already received ${sends.length} proactive messages in the last 24 hours, ` +
        `which is the limit of ${LIMIT} across all channels (sms, push, chat), so this message was held. ` +
        `The next one can be sent after ${formatTime(retryMs)}.`,
    };
  } finally {
    await releaseLock(lock);
  }
}
