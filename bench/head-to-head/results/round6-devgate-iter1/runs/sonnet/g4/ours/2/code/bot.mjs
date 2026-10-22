import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Rolling window: a slot counts from its send time until windowHours later
// (start of the window excluded, so a slot exactly windowHours old is free).
// Released slots count for nothing. One state file per lead, guarded by an
// exclusive lock file, so every worker process sees the same history.

const LOCK_STALE_MS = 15000;
const LOCK_TIMEOUT_MS = 30000;
const RETAIN_MS = 30 * 24 * 3600 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dir() {
  const d = process.env.STATE_DIR;
  if (!d) throw new Error("STATE_DIR is not set");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const enc = (userId) => Buffer.from(userId, "utf8").toString("base64url");
const dec = (s) => Buffer.from(s, "base64url").toString("utf8");
const fileFor = (d, userId) => path.join(d, `lead-${enc(userId)}.json`);

async function withLock(d, userId, fn) {
  const lock = fileFor(d, userId) + ".lock";
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx");
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lock);
      } catch {}
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error("lock timeout");
      await sleep(5 + Math.random() * 15);
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
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { slots: [] };
    throw e;
  }
}

function save(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

const posInt = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;

export async function reserve(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request ?? {};
  const t = now instanceof Date ? now.getTime() : NaN;
  if (typeof userId !== "string" || !userId || !posInt(maxPerWindow) ||
      !posInt(windowHours) || !posInt(minGapMinutes) || Number.isNaN(t)) {
    return { allowed: false, reason: "invalid_request", reservationId: null };
  }
  const d = dir();
  const file = fileFor(d, userId);
  return withLock(d, userId, () => {
    const data = load(file);
    data.slots = data.slots.filter((s) => s.t > t - RETAIN_MS);
    const live = data.slots.filter((s) => !s.released);
    const windowMs = windowHours * 3600000;
    const gapMs = minGapMinutes * 60000;

    const inWindow = live.filter((s) => s.t > t - windowMs && s.t <= t);
    if (inWindow.length >= maxPerWindow) {
      return { allowed: false, reason: "max_per_window_reached", reservationId: null };
    }
    if (live.some((s) => Math.abs(t - s.t) < gapMs)) {
      return { allowed: false, reason: "min_gap_not_elapsed", reservationId: null };
    }
    const reservationId = `${enc(userId)}.${crypto.randomUUID()}`;
    data.slots.push({ id: reservationId, t, released: false });
    save(file, data);
    return { allowed: true, reason: null, reservationId };
  });
}

export async function release(reservationId) {
  if (typeof reservationId !== "string") return false;
  const i = reservationId.indexOf(".");
  if (i < 1) return false;
  let userId;
  try { userId = dec(reservationId.slice(0, i)); } catch { return false; }
  const d = dir();
  const file = fileFor(d, userId);
  return withLock(d, userId, () => {
    const data = load(file);
    const s = data.slots.find((x) => x.id === reservationId);
    if (!s) return false;
    if (!s.released) {
      s.released = true;
      save(file, data);
    }
    return true;
  });
}
