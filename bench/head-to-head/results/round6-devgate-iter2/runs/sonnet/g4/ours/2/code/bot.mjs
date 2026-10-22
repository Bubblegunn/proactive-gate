// Shared send-slot limiter. State: one JSON file per lead in STATE_DIR, guarded by a lock directory.
// Sliding window: a slot counts until windowHours after it was reserved. A released slot counts for nothing.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const HOUR = 3600e3;
const MINUTE = 60e3;
const KEEP_MS = 400 * 24 * HOUR;

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR is not set");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const enc = (userId) => Buffer.from(String(userId), "utf8").toString("hex");
const dec = (hex) => Buffer.from(hex, "hex").toString("utf8");

function withLock(dir, key, fn) {
  const lock = path.join(dir, `${key}.lock`);
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.rmdirSync(lock); // holder crashed
      } catch {}
      if (Date.now() > deadline) throw new Error("lock timeout");
      sleep(2 + Math.random() * 8);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.rmdirSync(lock); } catch {}
  }
}

function load(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(data.slots) ? data.slots : [];
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

function save(file, slots) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ slots }));
  fs.renameSync(tmp, file);
}

const posInt = (n) => typeof n === "number" && Number.isFinite(n);

export function reserve(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request ?? {};
  const t = now instanceof Date ? now.getTime() : NaN;
  if (userId == null || userId === "" || !Number.isFinite(t) ||
      !posInt(maxPerWindow) || maxPerWindow < 0 || !posInt(windowHours) || windowHours <= 0 ||
      !posInt(minGapMinutes) || minGapMinutes < 0) {
    return { allowed: false, reason: "invalid_request", reservationId: null };
  }
  const dir = stateDir();
  const key = enc(userId);
  const file = path.join(dir, `${key}.json`);
  return withLock(dir, key, () => {
    const slots = load(file).filter((s) => s.at > t - KEEP_MS);
    // Earliest time each limit would allow a send; null when it does not block.
    let gapUntil = null;
    if (slots.length) {
      const last = Math.max(...slots.map((s) => s.at));
      if (t < last + minGapMinutes * MINUTE) gapUntil = last + minGapMinutes * MINUTE;
    }
    let windowUntil = null;
    const inWindow = slots.filter((s) => s.at + windowHours * HOUR > t).sort((a, b) => a.at - b.at);
    if (inWindow.length >= maxPerWindow) {
      // Slot that must age out so that fewer than maxPerWindow remain.
      const frees = inWindow[inWindow.length - maxPerWindow];
      windowUntil = frees ? frees.at + windowHours * HOUR : t;
    }
    if (gapUntil !== null || windowUntil !== null) {
      const gapWins = windowUntil === null || (gapUntil !== null && gapUntil > windowUntil);
      return { allowed: false, reason: gapWins ? "min_gap" : "window_limit", reservationId: null };
    }
    const id = `${key}.${crypto.randomUUID()}`;
    slots.push({ id, at: t });
    save(file, slots);
    return { allowed: true, reason: null, reservationId: id };
  });
}

export function release(reservationId) {
  if (typeof reservationId !== "string") return false;
  const [key, uuid] = reservationId.split(".");
  if (!/^([0-9a-f]{2})+$/.test(key ?? "") || !uuid) return false;
  const dir = stateDir();
  const file = path.join(dir, `${key}.json`);
  return withLock(dir, key, () => {
    const slots = load(file);
    const left = slots.filter((s) => s.id !== reservationId);
    if (left.length === slots.length) return false;
    save(file, left);
    return true;
  });
}
