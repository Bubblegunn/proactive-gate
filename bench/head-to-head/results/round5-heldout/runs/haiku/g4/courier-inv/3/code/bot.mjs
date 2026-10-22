// Shared send rate limiter for proactive lead messaging.
//
// Every worker process points STATE_DIR at the same directory. Each lead has
// one JSON file holding the sends that count toward its limits. A per-lead
// lock directory (mkdir is atomic) serializes read-check-write for that lead,
// so two workers can never both take the last slot.
//
// What counts: a reservation counts from the moment it is granted until it is
// released. A granted reservation the caller never releases stays counted,
// because the message may have left. Denied attempts never count.
//
// Window: rolling. A send counts for exactly windowHours after its `now`.
// Gap: measured from the most recent counted send, in either direction.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const LOCK_STALE_MS = 30 * 1000;
const LOCK_TIMEOUT_MS = 10 * 1000;

export async function reserve(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = parseRequest(request);
  const at = parseNow(now);
  const windowMs = windowHours * HOUR_MS;
  const gapMs = minGapMinutes * MINUTE_MS;

  return withLead(userId, async (file) => {
    const store = await loadStore(file, userId);

    // Keep history at least as long as the longest window or gap any caller has asked for.
    store.retainMs = Math.max(store.retainMs ?? 0, windowMs, gapMs);
    store.sends = store.sends.filter((s) => s.at >= at - store.retainMs);

    const sendsInWindow = store.sends.filter((s) => s.at > at - windowMs);
    if (sendsInWindow.length >= maxPerWindow) {
      return denied("window_limit_reached");
    }

    const lastAt = store.sends.reduce((latest, s) => Math.max(latest, s.at), -Infinity);
    if (at - lastAt < gapMs) {
      return denied("min_gap_not_elapsed");
    }

    const reservationId = encodeReservationId(userId);
    store.sends.push({ id: reservationId, at });
    await saveStore(file, store);
    return { allowed: true, reason: null, reservationId };
  });
}

export async function release(reservationId) {
  const userId = decodeReservationId(reservationId);

  return withLead(userId, async (file) => {
    const store = await loadStore(file, userId);
    const before = store.sends.length;
    store.sends = store.sends.filter((s) => s.id !== reservationId);
    if (store.sends.length === before) {
      // Already released, or pruned after its window. Nothing to give back.
      return false;
    }
    await saveStore(file, store);
    return true;
  });
}

function denied(reason) {
  return { allowed: false, reason, reservationId: null };
}

function parseRequest(request) {
  if (!request || typeof request !== "object") {
    throw new TypeError("request must be an object");
  }
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request;
  if (typeof userId !== "string" || userId.length === 0) {
    throw new TypeError("request.userId must be a non-empty string");
  }
  if (!Number.isInteger(maxPerWindow) || maxPerWindow < 0) {
    throw new TypeError("request.maxPerWindow must be an integer >= 0");
  }
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    throw new TypeError("request.windowHours must be a number > 0");
  }
  if (!Number.isFinite(minGapMinutes) || minGapMinutes < 0) {
    throw new TypeError("request.minGapMinutes must be a number >= 0");
  }
  return { userId, maxPerWindow, windowHours, minGapMinutes };
}

function parseNow(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  return now.getTime();
}

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) {
    throw new Error("STATE_DIR is not set");
  }
  return dir;
}

// Reservation ids carry the lead so release() can find the right file.
// "." is not in the base64url alphabet, so it is a safe separator.
function encodeReservationId(userId) {
  const encoded = Buffer.from(userId, "utf8").toString("base64url");
  return `rsv.${encoded}.${randomUUID()}`;
}

function decodeReservationId(reservationId) {
  const parts = typeof reservationId === "string" ? reservationId.split(".") : [];
  if (parts.length !== 3 || parts[0] !== "rsv") {
    throw new TypeError("reservationId is malformed");
  }
  return Buffer.from(parts[1], "base64url").toString("utf8");
}

function leadKey(userId) {
  return createHash("sha256").update(userId, "utf8").digest("hex");
}

async function withLead(userId, fn) {
  const dir = stateDir();
  const leadsDir = join(dir, "leads");
  const locksDir = join(dir, "locks");
  await mkdir(leadsDir, { recursive: true });
  await mkdir(locksDir, { recursive: true });

  const key = leadKey(userId);
  const lockPath = join(locksDir, `${key}.lock`);
  await acquireLock(lockPath, key);
  try {
    return await fn(join(leadsDir, `${key}.json`));
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function acquireLock(lockPath, key) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lockPath);
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }

    // A holder that died mid-operation leaves its lock behind. Holders keep
    // the lock for milliseconds, so an old one is safe to remove.
    try {
      const info = await stat(lockPath);
      if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }

    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for send lock on lead ${key}`);
    }
    await sleep(5 + Math.random() * 20);
  }
}

async function loadStore(file, userId) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { userId, retainMs: 0, sends: [] };
    throw err;
  }
  // A corrupt file throws rather than resetting, because a reset would
  // silently grant a fresh burst of sends.
  return JSON.parse(raw);
}

async function saveStore(file, store) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(store));
  await rename(tmp, file);
}
