import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Per-lead rate limiter shared by all workers through STATE_DIR.
// One JSON file per lead, guarded by an mkdir lock; writes are temp file + rename.
// Limits are per lead across all channels (the lead experiences total messages).
// The window is sliding: a reservation counts while at + window > now.
// A released reservation is deleted, so it counts toward nothing.

const KEEP_MS = 30 * 24 * 3600 * 1000;
const STALE_LOCK_MS = 10_000;

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR is not set");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const hashUser = (userId) => crypto.createHash("sha256").update(userId).digest("hex").slice(0, 32);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function withLock(dir, key, fn) {
  const lock = path.join(dir, `${key}.lock`);
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > STALE_LOCK_MS) fs.rmSync(lock, { recursive: true, force: true });
      } catch {}
      if (Date.now() > deadline) throw new Error("could not acquire lock for " + key);
      sleep(2 + Math.random() * 8);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function load(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(d.reservations) ? d.reservations : [];
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

function save(file, reservations) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ reservations }));
  fs.renameSync(tmp, file);
}

const deny = (reason) => ({ allowed: false, reason, reservationId: null });
const pos = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;

export function reserve(request, now) {
  const t = now instanceof Date ? now.getTime() : NaN;
  if (!request || typeof request.userId !== "string" || request.userId === "" || Number.isNaN(t)) {
    return deny("invalid_request");
  }
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request;
  if (!Number.isInteger(maxPerWindow) || maxPerWindow < 0 || !pos(windowHours) ||
      typeof minGapMinutes !== "number" || !(minGapMinutes >= 0) || !Number.isFinite(minGapMinutes)) {
    return deny("invalid_request");
  }
  const dir = stateDir();
  const key = hashUser(userId);
  const file = path.join(dir, `${key}.json`);
  return withLock(dir, key, () => {
    let list = load(file).filter((r) => r.at > t - KEEP_MS);
    const windowMs = windowHours * 3600 * 1000;
    const gapMs = minGapMinutes * 60 * 1000;
    // Gap is checked first: it is the shortest-term limit.
    if (gapMs > 0 && list.some((r) => Math.abs(t - r.at) < gapMs)) return deny("min_gap_not_elapsed");
    if (list.filter((r) => r.at > t - windowMs).length >= maxPerWindow) return deny("max_per_window_reached");
    const id = `${key}.${crypto.randomUUID()}`;
    list.push({ id, at: t });
    save(file, list);
    return { allowed: true, reason: null, reservationId: id };
  });
}

export function release(reservationId) {
  if (typeof reservationId !== "string") return false;
  const m = /^([0-9a-f]{32})\.[0-9a-f-]{36}$/.exec(reservationId);
  if (!m) return false;
  const dir = stateDir();
  const file = path.join(dir, `${m[1]}.json`);
  return withLock(dir, m[1], () => {
    const list = load(file);
    const rest = list.filter((r) => r.id !== reservationId);
    if (rest.length === list.length) return false;
    save(file, rest);
    return true;
  });
}
