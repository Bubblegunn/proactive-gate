// Shared per-lead send limiter. State lives in STATE_DIR (one JSON file per lead),
// guarded by a cross-process lock file, so all workers see the same history.
//
// Semantics (what the recipient experiences):
// - Rolling window: a send counts for windowHours after it was reserved. No fixed calendar buckets,
//   so a lead can never get more than maxPerWindow messages in any windowHours span.
// - Every live reservation counts, including ones whose send is still in flight. A released slot
//   (message never delivered) counts for nothing: neither for the cap nor for the minimum gap.
// - Denied calls are not recorded and do not extend any limit.
// - Reasons: "min_gap" (too soon after the last message), "window_cap" (cap in window reached).
//   If both apply, the one that clears later is reported.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const HOUR = 3600e3;
const MIN = 60e3;
const LOCK_STALE_MS = 10e3;
const MIN_RETENTION_MS = 7 * 24 * HOUR;

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(sleepBuf, 0, 0, ms);

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR is not set");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const keyOf = (userId) => createHash("sha256").update(String(userId)).digest("hex").slice(0, 32);

function withLock(dir, key, fn) {
  const lock = path.join(dir, `${key}.lock`);
  const deadline = Date.now() + 30e3;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, "wx"));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          // Take over a lock left by a crashed worker. rename is atomic: only one breaker wins.
          const grave = `${lock}.${randomUUID()}`;
          fs.renameSync(lock, grave);
          fs.rmSync(grave, { force: true });
          continue;
        }
      } catch {}
      if (Date.now() > deadline) throw new Error("timeout waiting for lock");
      sleep(2 + Math.random() * 8);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

function load(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(d.reservations) ? d.reservations : [];
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e; // never treat unreadable history as empty: that would bypass the limits
  }
}

function save(file, reservations) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ reservations }));
  fs.renameSync(tmp, file);
}

export function reserve(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request ?? {};
  if (userId == null || userId === "") throw new Error("userId required");
  if (!Number.isFinite(maxPerWindow) || maxPerWindow < 0) throw new Error("bad maxPerWindow");
  if (!Number.isFinite(windowHours) || windowHours < 0) throw new Error("bad windowHours");
  if (!Number.isFinite(minGapMinutes) || minGapMinutes < 0) throw new Error("bad minGapMinutes");
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(t)) throw new Error("bad now");

  const dir = stateDir();
  const key = keyOf(userId);
  const file = path.join(dir, `${key}.json`);
  const windowMs = windowHours * HOUR;
  const gapMs = minGapMinutes * MIN;

  return withLock(dir, key, () => {
    const keepAfter = t - Math.max(windowMs, gapMs, MIN_RETENTION_MS);
    const all = load(file).filter((r) => r.at > keepAfter);

    const inWindow = all.filter((r) => r.at > t - windowMs);
    const last = all.reduce((m, r) => Math.max(m, r.at), -Infinity);

    // Time at which each limit would let a new message through.
    let gapClears = -Infinity;
    if (gapMs > 0 && all.length) gapClears = last + gapMs;
    let capClears = -Infinity;
    if (inWindow.length >= maxPerWindow) {
      const sorted = inWindow.map((r) => r.at).sort((a, b) => a - b);
      // Window frees a slot once enough of the oldest sends have aged out.
      capClears = maxPerWindow === 0 ? Infinity : sorted[sorted.length - maxPerWindow] + windowMs;
    }

    if (gapClears > t || capClears > t) {
      if (all.length) save(file, all); // persist pruning only
      return {
        allowed: false,
        reason: capClears >= gapClears ? "window_cap" : "min_gap",
        reservationId: null,
      };
    }

    const id = `${key}-${randomUUID()}`;
    all.push({ id, at: t });
    save(file, all);
    return { allowed: true, reason: null, reservationId: id };
  });
}

export function release(reservationId) {
  const m = /^([0-9a-f]{32})-[0-9a-f-]{36}$/.exec(String(reservationId ?? ""));
  if (!m) return;
  const dir = stateDir();
  const key = m[1];
  const file = path.join(dir, `${key}.json`);
  withLock(dir, key, () => {
    const all = load(file);
    const rest = all.filter((r) => r.id !== reservationId);
    if (rest.length !== all.length) save(file, rest); // unknown/already-released id: no-op
  });
}
