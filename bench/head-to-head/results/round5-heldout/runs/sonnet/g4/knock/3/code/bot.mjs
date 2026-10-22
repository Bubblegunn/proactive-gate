// Shared send-rate limiter for proactive messages. No dependencies.
//
// State: one JSON file per lead in STATE_DIR, guarded by a per-lead lock
// directory (mkdir is atomic), so every worker process sees the same history
// and a restart loses nothing.
//
// Semantics:
//  - Rolling window: a slot counts for windowHours after it was reserved
//    (not a calendar day), so a lead never gets more than maxPerWindow
//    messages in ANY span of windowHours.
//  - Minimum gap: measured from the latest active reservation.
//  - Denied calls are not recorded. Released slots stop counting for both limits.
//  - Reservations are recorded immediately, so a concurrent worker sees them.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const HOUR = 3600_000;
const MINUTE = 60_000;
const KEEP_MS = 90 * 24 * HOUR; // history older than this can never matter
const LOCK_STALE_MS = 15_000; // a lock is only held for milliseconds
const LOCK_TIMEOUT_MS = 30_000;

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR is not set");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const keyOf = (userId) => crypto.createHash("sha256").update(String(userId)).digest("hex");

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(dir, key, fn) {
  const lock = path.join(dir, `${key}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (let spin = 0; ; spin++) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
        // Holder crashed. Rename first so only one waiter removes it.
        const gone = `${lock}.stale.${crypto.randomUUID()}`;
        fs.renameSync(lock, gone);
        fs.rmSync(gone, { recursive: true, force: true });
        continue;
      }
    } catch {
      continue; // lock vanished or another waiter took it; retry
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for rate-limit lock");
    sleep(2 + Math.min(spin, 20));
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function load(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(data.slots) ? data.slots : [];
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e; // never treat unreadable history as empty: that would allow a burst
  }
}

function save(file, slots) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ slots }));
  fs.renameSync(tmp, file);
}

const deny = (reason) => ({ allowed: false, reason, reservationId: null });

export function reserve(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request ?? {};
  const t = now instanceof Date ? now.getTime() : NaN;
  if (
    userId === undefined || userId === null || userId === "" ||
    !Number.isFinite(t) ||
    !Number.isFinite(maxPerWindow) || maxPerWindow < 0 ||
    !Number.isFinite(windowHours) || windowHours <= 0 ||
    !Number.isFinite(minGapMinutes) || minGapMinutes < 0
  ) {
    return deny("invalid_request");
  }

  const dir = stateDir();
  const key = keyOf(userId);
  const file = path.join(dir, `${key}.json`);

  return withLock(dir, key, () => {
    const slots = load(file).filter((s) => s.at > t - KEEP_MS);

    const inWindow = slots.filter((s) => s.at > t - windowHours * HOUR);
    if (inWindow.length >= maxPerWindow) return deny("window_limit_reached");

    // Includes slots dated after `now` (clock skew between workers): treat as too close.
    const latest = slots.reduce((m, s) => Math.max(m, s.at), -Infinity);
    if (slots.length > 0 && t - latest < minGapMinutes * MINUTE) return deny("min_gap_not_elapsed");

    const reservationId = `${key}-${crypto.randomUUID()}`;
    slots.push({ id: reservationId, at: t });
    save(file, slots);
    return { allowed: true, reason: null, reservationId };
  });
}

export function release(reservationId) {
  const m = /^([0-9a-f]{64})-[0-9a-f-]{36}$/.exec(String(reservationId ?? ""));
  if (!m) return false;
  const dir = stateDir();
  const key = m[1];
  const file = path.join(dir, `${key}.json`);
  return withLock(dir, key, () => {
    const slots = load(file);
    const rest = slots.filter((s) => s.id !== reservationId);
    if (rest.length === slots.length) return false; // unknown or already released
    save(file, rest);
    return true;
  });
}
