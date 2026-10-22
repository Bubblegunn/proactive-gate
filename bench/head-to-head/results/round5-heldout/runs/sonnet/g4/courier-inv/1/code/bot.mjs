// Shared per-lead send rate limiter. State lives in STATE_DIR, one JSON file per lead,
// guarded by a per-lead lock file so concurrent worker processes cannot both claim a slot.
//
// Semantics:
// - Every active (not released) reservation counts as a send, from the moment it is reserved.
// - The window is a sliding window: a reservation counts while its time is within the last
//   windowHours before `now`. There is no fixed reset boundary, so a lead never gets a burst
//   across a boundary.
// - The gap applies to the closest active reservation in either direction of time, so slightly
//   skewed worker clocks cannot squeeze two messages together.
// - A refused request records nothing, so refusals do not extend the wait.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, openSync, writeSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const RETENTION_MS = 30 * 24 * 3600 * 1000;
const LOCK_TIMEOUT_MS = 30000;

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR is not set");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const userKey = (userId) => createHash("sha256").update(String(userId)).digest("hex").slice(0, 32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

async function withLock(dir, key, fn) {
  const lockPath = join(dir, `${key}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    // Take over a lock whose owner process died. Rename is atomic, so only one waiter wins.
    try {
      const pid = parseInt(readFileSync(lockPath, "utf8"), 10);
      if (pid && !pidAlive(pid)) {
        const grave = `${lockPath}.stale.${randomUUID()}`;
        renameSync(lockPath, grave);
        try { unlinkSync(grave); } catch {}
        continue;
      }
    } catch {}
    if (Date.now() > deadline) throw new Error("timed out waiting for lock");
    await sleep(2 + Math.random() * 8);
  }
  try {
    return await fn();
  } finally {
    try { unlinkSync(lockPath); } catch {}
  }
}

function load(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(data.reservations) ? data.reservations : [];
  } catch {
    return [];
  }
}

function save(file, reservations) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ reservations }));
  renameSync(tmp, file);
}

export async function reserve(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request;
  const dir = stateDir();
  const key = userKey(userId);
  const file = join(dir, `${key}.json`);
  const t = now.getTime();
  const windowMs = windowHours * 3600 * 1000;
  const gapMs = minGapMinutes * 60 * 1000;

  return withLock(dir, key, () => {
    const all = load(file).filter((r) => r.at > t - RETENTION_MS);
    const inWindow = all.filter((r) => r.at > t - windowMs);
    const tooClose = all.some((r) => Math.abs(t - r.at) < gapMs);

    let reason = null;
    if (inWindow.length >= maxPerWindow) reason = "window_limit_reached";
    else if (tooClose) reason = "min_gap_not_elapsed";

    if (reason) {
      save(file, all);
      return { allowed: false, reason, reservationId: null };
    }
    const reservationId = `${key}.${randomUUID()}`;
    all.push({ id: reservationId, at: t });
    save(file, all);
    return { allowed: true, reason: null, reservationId };
  });
}

export async function release(reservationId) {
  const key = String(reservationId ?? "").split(".")[0];
  if (!/^[0-9a-f]{32}$/.test(key)) return;
  const dir = stateDir();
  const file = join(dir, `${key}.json`);
  await withLock(dir, key, () => {
    const all = load(file);
    const rest = all.filter((r) => r.id !== reservationId);
    if (rest.length !== all.length) save(file, rest);
  });
}
