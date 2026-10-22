import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Rolling window: a slot is held for exactly windowHours after its reservation time,
// then frees (reservation at t counts while t > now - window). Only live reservations
// count; refused attempts and released slots never count. The gap is measured from the
// most recent live reservation.

const KEEP_MS = 400 * 24 * 3600e3;
const LOCK_STALE_MS = 10000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dir() {
  const d = process.env.STATE_DIR;
  if (!d) throw new Error("STATE_DIR is not set");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

const userKey = (userId) => crypto.createHash("sha256").update(String(userId)).digest("hex");

async function withLock(d, key, fn) {
  const lock = path.join(d, key + ".lock");
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.renameSync(lock, `${lock}.stale.${process.pid}.${crypto.randomUUID()}`);
          continue;
        }
      } catch {}
      if (Date.now() > deadline) throw new Error("lock timeout");
      await sleep(5 + Math.random() * 15);
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
    return JSON.parse(fs.readFileSync(file, "utf8")).reservations || [];
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

export async function reserve(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request;
  const d = dir();
  const key = userKey(userId);
  const file = path.join(d, key + ".json");
  const t = now.getTime();
  return withLock(d, key, () => {
    const live = load(file).filter((r) => t - r.at < KEEP_MS);
    const times = live.map((r) => r.at);
    const gapMs = minGapMinutes * 60e3;
    const winMs = windowHours * 3600e3;
    if (gapMs > 0 && times.some((x) => t - x < gapMs)) {
      save(file, live);
      return { allowed: false, reason: "min_gap", reservationId: null };
    }
    if (times.filter((x) => t - x < winMs).length >= maxPerWindow) {
      save(file, live);
      return { allowed: false, reason: "window_cap", reservationId: null };
    }
    const id = `${key}.${crypto.randomUUID()}`;
    live.push({ id, at: t });
    save(file, live);
    return { allowed: true, reason: null, reservationId: id };
  });
}

export async function release(reservationId) {
  const key = String(reservationId).split(".")[0];
  if (!/^[0-9a-f]{64}$/.test(key)) return;
  const d = dir();
  const file = path.join(d, key + ".json");
  await withLock(d, key, () => {
    const all = load(file);
    const rest = all.filter((r) => r.id !== reservationId);
    if (rest.length !== all.length) save(file, rest);
  });
}
