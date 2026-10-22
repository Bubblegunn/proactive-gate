import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Shared send-rate limiter. One JSON history file per lead in STATE_DIR, guarded by a
// per-lead lock directory (mkdir is atomic), so every worker process sees the same history.
//
// Semantics:
// - Sliding window: a slot counts while its time is within the last windowHours (exclusive at the edge).
// - Released slots count toward nothing (the lead never got the message).
// - Min gap is measured from the most recent active slot to `now`.
// - Check order: min gap first, then window cap. Denied calls record nothing.

const MIN = 60_000;
const HOUR = 60 * MIN;
const KEEP_MS = 31 * 24 * HOUR;
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 20_000;

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR is not set");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const userKey = (userId) => crypto.createHash("sha256").update(String(userId)).digest("hex").slice(0, 32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withLock(dir, key, fn) {
  const lock = path.join(dir, `${key}.lock`);
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          const grave = `${lock}.stale.${process.pid}.${crypto.randomUUID()}`;
          fs.renameSync(lock, grave); // only one stealer wins the rename
          fs.rmSync(grave, { recursive: true, force: true });
          continue;
        }
      } catch {}
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error("could not acquire lock for " + key);
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
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(data.slots) ? data.slots : [];
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e; // corrupt history: fail rather than silently allow sends
  }
}

function save(file, slots) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, JSON.stringify({ slots }));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function positive(v, name, allowZero) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || (!allowZero && v === 0)) {
    throw new Error(`invalid ${name}`);
  }
  return v;
}

export async function reserve(request, now) {
  const { userId } = request ?? {};
  if (userId === undefined || userId === null || userId === "") throw new Error("invalid userId");
  const max = positive(request.maxPerWindow, "maxPerWindow", true);
  const windowMs = positive(request.windowHours, "windowHours", false) * HOUR;
  const gapMs = positive(request.minGapMinutes, "minGapMinutes", true) * MIN;
  const t = new Date(now).getTime();
  if (!Number.isFinite(t)) throw new Error("invalid now");

  const dir = stateDir();
  const key = userKey(userId);
  const file = path.join(dir, `${key}.json`);

  return withLock(dir, key, () => {
    const slots = load(file).filter((s) => t - s.at < KEEP_MS);
    const active = slots.filter((s) => !s.released);

    const last = active.reduce((m, s) => Math.max(m, s.at), -Infinity);
    if (gapMs > 0 && active.length && Math.abs(t - last) < gapMs) {
      return { allowed: false, reason: "min_gap", reservationId: null };
    }
    const inWindow = active.filter((s) => s.at > t - windowMs).length;
    if (inWindow >= max) {
      return { allowed: false, reason: "window_cap", reservationId: null };
    }

    const reservationId = `${key}.${crypto.randomUUID()}`;
    slots.push({ id: reservationId, at: t, released: false });
    save(file, slots);
    return { allowed: true, reason: null, reservationId };
  });
}

export async function release(reservationId) {
  const m = /^([0-9a-f]{32})\.[0-9a-f-]{36}$/.exec(String(reservationId));
  if (!m) return false;
  const dir = stateDir();
  const key = m[1];
  const file = path.join(dir, `${key}.json`);
  return withLock(dir, key, () => {
    const slots = load(file);
    const s = slots.find((x) => x.id === reservationId);
    if (!s || s.released) return false; // unknown or already released: idempotent
    s.released = true;
    save(file, slots);
    return true;
  });
}
