// Shared send-slot limiter. State lives in STATE_DIR, one JSON file per lead,
// guarded by a per-lead lock file so any number of worker processes agree.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MIN = 60_000;
const HOUR = 3_600_000;
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 30_000;
const KEEP_MS = 366 * 24 * HOUR; // limits vary per call, so keep history long

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR is not set");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const enc = (userId) => Buffer.from(userId, "utf8").toString("base64url");
const dec = (s) => Buffer.from(s, "base64url").toString("utf8");
const fileFor = (dir, userId) => path.join(dir, `lead-${enc(userId)}`);

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(sleepBuf, 0, 0, ms);

function withLock(base, fn) {
  const lock = base + ".lock";
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, "wx"));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          // crashed holder: rename is atomic, so only one stealer wins
          fs.renameSync(lock, `${lock}.stale.${process.pid}.${crypto.randomUUID()}`);
          continue;
        }
      } catch { continue; }
      if (Date.now() > deadline) throw new Error("rate limiter lock timeout");
      sleep(5 + Math.random() * 15);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lock); } catch {}
  }
}

function load(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(d.slots) ? d.slots : [];
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e; // corrupt state: fail closed rather than allow a burst
  }
}

function save(file, slots) {
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`;
  const fd = fs.openSync(tmp, "w");
  fs.writeSync(fd, JSON.stringify({ slots }));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
}

function positive(v) { return typeof v === "number" && Number.isFinite(v) && v > 0; }

export function reserve(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request ?? {};
  if (typeof userId !== "string" || userId === "") throw new TypeError("userId required");
  if (!Number.isInteger(maxPerWindow) || maxPerWindow < 0) throw new TypeError("bad maxPerWindow");
  if (!positive(windowHours)) throw new TypeError("bad windowHours");
  if (typeof minGapMinutes !== "number" || !(minGapMinutes >= 0)) throw new TypeError("bad minGapMinutes");
  const t = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(t)) throw new TypeError("bad now");

  const dir = stateDir();
  const file = fileFor(dir, userId);
  return withLock(file, () => {
    // Only live reservations are stored; released ones are removed, and
    // refused attempts are never recorded, so neither counts toward limits.
    let slots = load(file).filter((s) => s.t > t - KEEP_MS);
    const windowStart = t - windowHours * HOUR;
    // Sliding window: a slot counts until windowHours after it was reserved.
    // Slots stamped in the future (caller clock skew) also count.
    const inWindow = slots.filter((s) => s.t > windowStart).length;
    // abs(): workers' clocks may differ, so "too close" works in both directions.
    const tooClose = slots.some((s) => Math.abs(t - s.t) < minGapMinutes * MIN);

    let reason = null;
    if (inWindow >= maxPerWindow) reason = "window_limit";
    else if (tooClose) reason = "min_gap";

    if (reason) {
      return { allowed: false, reason, reservationId: null };
    }
    const id = `${enc(userId)}.${crypto.randomUUID()}`;
    slots.push({ id, t });
    save(file, slots);
    return { allowed: true, reason: null, reservationId: id };
  });
}

export function release(reservationId) {
  if (typeof reservationId !== "string") return;
  const dot = reservationId.indexOf(".");
  if (dot < 1) return;
  const userId = dec(reservationId.slice(0, dot));
  const dir = stateDir();
  const file = fileFor(dir, userId);
  withLock(file, () => {
    const slots = load(file);
    const rest = slots.filter((s) => s.id !== reservationId);
    if (rest.length !== slots.length) save(file, rest); // idempotent
  });
}
