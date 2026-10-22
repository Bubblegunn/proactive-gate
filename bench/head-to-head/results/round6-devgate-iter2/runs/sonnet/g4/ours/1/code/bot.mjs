import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Shared per-lead rate limiter. State lives in STATE_DIR (read on every call):
// one JSON file per lead, guarded by a per-lead lock directory (mkdir is atomic).
// Rules:
// - Sliding window: a slot counts while its time is later than now - window.
//   A slot exactly windowHours old no longer counts.
// - Min gap: measured from the latest slot. Exactly minGapMinutes later is allowed.
// - A reserved slot counts even if the send outcome is unknown; only release() frees it.
// - Refused attempts spend nothing.

const KEEP_MS = 30 * 24 * 3600 * 1000;
const LOCK_STALE_MS = 10000;

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR is not set");
  const users = path.join(dir, "rate-limit");
  fs.mkdirSync(users, { recursive: true });
  return users;
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64url");

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(dir, key, fn) {
  const lock = path.join(dir, key + ".lock");
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          const gone = `${lock}.stale.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
          fs.renameSync(lock, gone); // only one worker wins this rename
          fs.rmSync(gone, { recursive: true, force: true });
          continue;
        }
      } catch {}
      if (Date.now() > deadline) throw new Error("lock timeout for " + key);
      sleep(5 + Math.random() * 15);
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
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(data.slots) ? data.slots : [];
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e; // corrupt state: fail rather than allow an unbounded burst
  }
}

function save(file, slots) {
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify({ slots }));
  fs.renameSync(tmp, file);
}

export function reserve(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request ?? {};
  if (typeof userId !== "string" || userId === "") throw new Error("userId required");
  if (!Number.isFinite(maxPerWindow) || maxPerWindow < 0) throw new Error("bad maxPerWindow");
  if (!Number.isFinite(windowHours) || windowHours < 0) throw new Error("bad windowHours");
  if (!Number.isFinite(minGapMinutes) || minGapMinutes < 0) throw new Error("bad minGapMinutes");
  const t = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(t)) throw new Error("now must be a valid Date");

  const dir = stateDir();
  const key = b64(userId);
  const file = path.join(dir, key + ".json");
  return withLock(dir, key, () => {
    const slots = load(file).filter((s) => s.at > t - KEEP_MS);
    const windowStart = t - windowHours * 3600000;
    const inWindow = slots.filter((s) => s.at > windowStart).sort((a, b) => a.at - b.at);
    const last = slots.reduce((m, s) => Math.max(m, s.at), -Infinity);

    // retry time of each limit; the later one is what the lead experiences
    let retryWindow = -Infinity;
    if (inWindow.length >= maxPerWindow) {
      // free again when enough old slots leave the window
      const idx = inWindow.length - maxPerWindow;
      retryWindow = maxPerWindow === 0 ? Infinity : inWindow[idx].at + windowHours * 3600000;
    }
    const retryGap = last + minGapMinutes * 60000;
    const gapBlocks = last !== -Infinity && t < retryGap;
    const windowBlocks = inWindow.length >= maxPerWindow;

    if (windowBlocks || gapBlocks) {
      if (slots.length) save(file, slots);
      const reason = windowBlocks && (!gapBlocks || retryWindow >= retryGap) ? "max_per_window" : "min_gap";
      return { allowed: false, reason, reservationId: null };
    }

    const id = `${key}.${crypto.randomBytes(12).toString("hex")}`;
    slots.push({ id, at: t });
    save(file, slots);
    return { allowed: true, reason: null, reservationId: id };
  });
}

export function release(reservationId) {
  if (typeof reservationId !== "string") return false;
  const key = reservationId.split(".")[0];
  if (!key || !/^[A-Za-z0-9_-]+$/.test(key)) return false;
  const dir = stateDir();
  const file = path.join(dir, key + ".json");
  return withLock(dir, key, () => {
    const slots = load(file);
    const rest = slots.filter((s) => s.id !== reservationId);
    if (rest.length === slots.length) return false; // unknown or already released
    save(file, rest);
    return true;
  });
}
