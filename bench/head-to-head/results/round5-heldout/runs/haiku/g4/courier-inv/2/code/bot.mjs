// Shared send-rate limiter for proactive follow-ups.
// Every worker on the machine calls reserve() before sending and release()
// if the provider rejects the message. State lives in STATE_DIR so it survives
// restarts and is shared across processes.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

// Sends older than this are pruned. windowHours is capped to stay inside it.
const RETENTION_MS = 30 * 24 * MS_PER_HOUR;
const MAX_WINDOW_HOURS = 720;

// A lock directory older than this belongs to a worker that died holding it.
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;

export const REASON_MAX_PER_WINDOW = "max_per_window_reached";
export const REASON_MIN_GAP = "min_gap_not_elapsed";

/**
 * Claims a send slot for one lead.
 * Counts every live (not released) reservation, whether or not it was sent yet,
 * so concurrent workers cannot exceed the cap between them.
 * @param {{userId: string, maxPerWindow: number, windowHours: number, minGapMinutes: number}} request
 * @param {Date} now caller's clock
 * @returns {Promise<{allowed: boolean, reason: string|null, reservationId: string|null}>}
 */
export async function reserve(request, now) {
  const req = validateRequest(request);
  const at = validateNow(now).getTime();
  const file = leadFile(stateDir(), req.userId);
  await mkdir(path.dirname(file), { recursive: true });

  return withLock(file, async () => {
    const history = (await readHistory(file)).filter((s) => at - s.at < RETENTION_MS);

    const windowMs = req.windowHours * MS_PER_HOUR;
    const sendsInWindow = history.filter((s) => at - s.at < windowMs).length;
    if (sendsInWindow >= req.maxPerWindow) {
      return denied(REASON_MAX_PER_WINDOW);
    }

    if (history.length > 0) {
      const lastAt = Math.max(...history.map((s) => s.at));
      // A negative gap (clock skew, last send "in the future") also blocks.
      if (at - lastAt < req.minGapMinutes * MS_PER_MINUTE) {
        return denied(REASON_MIN_GAP);
      }
    }

    const reservationId = encodeReservationId(req.userId);
    history.push({ id: reservationId, at });
    await writeHistory(file, history);
    return { allowed: true, reason: null, reservationId };
  });
}

/**
 * Gives back a slot after the provider rejected the message.
 * Idempotent: releasing an unknown or already released id does nothing.
 * @param {string} reservationId
 * @returns {Promise<void>}
 */
export async function release(reservationId) {
  const userId = decodeUserId(reservationId);
  const file = leadFile(stateDir(), userId);
  await mkdir(path.dirname(file), { recursive: true });

  await withLock(file, async () => {
    const history = await readHistory(file);
    const kept = history.filter((s) => s.id !== reservationId);
    if (kept.length !== history.length) {
      await writeHistory(file, kept);
    }
  });
}

function denied(reason) {
  return { allowed: false, reason, reservationId: null };
}

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) {
    throw new Error("STATE_DIR environment variable is not set");
  }
  return dir;
}

function validateRequest(request) {
  if (!request || typeof request !== "object") {
    throw new TypeError("request must be an object");
  }
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request;
  if (typeof userId !== "string" || userId.length === 0) {
    throw new TypeError("userId must be a non-empty string");
  }
  if (!Number.isInteger(maxPerWindow) || maxPerWindow < 1) {
    throw new TypeError("maxPerWindow must be a positive integer");
  }
  if (!(Number.isFinite(windowHours) && windowHours > 0 && windowHours <= MAX_WINDOW_HOURS)) {
    throw new TypeError(`windowHours must be > 0 and <= ${MAX_WINDOW_HOURS}`);
  }
  if (!(Number.isFinite(minGapMinutes) && minGapMinutes >= 0)) {
    throw new TypeError("minGapMinutes must be a number >= 0");
  }
  return { userId, maxPerWindow, windowHours, minGapMinutes };
}

function validateNow(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  return now;
}

function leadFile(dir, userId) {
  const key = createHash("sha256").update(userId).digest("hex");
  return path.join(dir, "leads", `${key}.json`);
}

// Format: base64url(userId) + "." + uuid. Neither part contains ".", so the
// userId can be recovered on release without a global index.
function encodeReservationId(userId) {
  return `${Buffer.from(userId, "utf8").toString("base64url")}.${randomUUID()}`;
}

function decodeUserId(reservationId) {
  const parts = typeof reservationId === "string" ? reservationId.split(".") : [];
  if (parts.length !== 2 || parts[0].length === 0) {
    throw new TypeError("reservationId is malformed");
  }
  return Buffer.from(parts[0], "base64url").toString("utf8");
}

async function readHistory(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  // Corrupt state must fail loudly. Resetting it would silently lift the limits.
  return JSON.parse(text).sends;
}

async function writeHistory(file, sends) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify({ sends }));
  await rename(tmp, file);
}

// mkdir is atomic across processes, so it works as a cross-process mutex.
async function withLock(file, fn) {
  const lockDir = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      await breakIfStale(lockDir);
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for lock ${lockDir}`);
      }
      await sleep(LOCK_RETRY_MS + Math.random() * LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function breakIfStale(lockDir) {
  try {
    const { mtimeMs } = await stat(lockDir);
    if (Date.now() - mtimeMs > LOCK_STALE_MS) {
      await rm(lockDir, { recursive: true, force: true });
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
