// Shared per-lead send rate limiter. State lives in STATE_DIR, one JSON file per lead,
// guarded by an atomic mkdir lock so any number of processes can call it safely.
//
// Semantics:
// - Sliding window: a slot counts while its time is within the last windowHours.
// - Every reserved slot counts (we cannot know if the lead saw it) until released.
// - Released slots count for nothing: the lead never received that message.
// - Rejected attempts are not recorded, so retrying never extends a lead's wait.
// - Min gap is measured against the nearest slot in either direction (callers' clocks may differ).
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const HOUR = 3600_000;
const MINUTE = 60_000;
const KEEP_MS = 90 * 24 * HOUR; // drop slots older than this when rewriting
const LOCK_STALE_MS = 30_000;

function dir() {
  const d = process.env.STATE_DIR;
  if (!d) throw new Error("STATE_DIR is not set");
  mkdirSync(d, { recursive: true });
  return d;
}

const encode = (userId) => Buffer.from(String(userId), "utf8").toString("base64url");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withLock(key, fn) {
  const base = join(dir(), key);
  const lock = base + ".lock";
  const start = Date.now();
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          // Holder crashed. Rename is atomic, so only one process wins the takeover.
          const trash = `${lock}.stale-${randomUUID()}`;
          renameSync(lock, trash);
          rmSync(trash, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between checks
      }
      if (Date.now() - start > 60_000) throw new Error("timed out waiting for lock");
      await sleep(2 + Math.random() * Math.min(20, 2 + i));
    }
  }
  try {
    return fn(base + ".json");
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function load(file) {
  try {
    const slots = JSON.parse(readFileSync(file, "utf8")).slots;
    return Array.isArray(slots) ? slots : [];
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e; // corrupt state: fail loudly rather than allow a burst
  }
}

function save(file, slots) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ slots }));
  renameSync(tmp, file);
}

function positive(v, name, allowZero = false) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || (!allowZero && v === 0)) {
    throw new Error(`invalid ${name}: ${v}`);
  }
  return v;
}

export async function reserve(request, now) {
  const { userId } = request ?? {};
  if (userId === undefined || userId === null || userId === "") throw new Error("userId required");
  const max = positive(request.maxPerWindow, "maxPerWindow", true);
  const windowMs = positive(request.windowHours, "windowHours") * HOUR;
  const gapMs = positive(request.minGapMinutes, "minGapMinutes", true) * MINUTE;
  const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(t)) throw new Error("invalid now");

  const key = encode(userId);
  return withLock(key, (file) => {
    const slots = load(file);
    const active = slots.filter((s) => s.t > t - windowMs);
    if (gapMs > 0 && slots.some((s) => Math.abs(t - s.t) < gapMs)) {
      return { allowed: false, reason: "min_gap", reservationId: null };
    }
    if (active.length >= max) {
      return { allowed: false, reason: "window_limit", reservationId: null };
    }
    const id = `${key}.${randomUUID()}`;
    const kept = slots.filter((s) => s.t > t - KEEP_MS);
    kept.push({ id, t });
    save(file, kept);
    return { allowed: true, reason: null, reservationId: id };
  });
}

export async function release(reservationId) {
  if (typeof reservationId !== "string") return;
  const key = reservationId.split(".")[0];
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return;
  await withLock(key, (file) => {
    const slots = load(file);
    const rest = slots.filter((s) => s.id !== reservationId);
    if (rest.length !== slots.length) save(file, rest); // unknown/double release is a no-op
  });
}
