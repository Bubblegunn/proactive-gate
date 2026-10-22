import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Rolling window: a reservation counts while now - reservedAt < windowHours
// (its start minute counts, the end minute does not). The minimum gap is
// measured from the latest held reservation. Released slots do not count.
// One JSON file per lead, guarded by an exclusive-create lock directory, so
// every worker process sees the same history and two workers cannot both win.

const KEEP_MS = 90 * 24 * 3600 * 1000;
const LOCK_STALE_MS = 10000;
const LOCK_WAIT_MS = 30000;

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR is not set");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const hashUser = (userId) =>
  crypto.createHash("sha256").update(String(userId)).digest("hex").slice(0, 32);

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(dir, h, fn) {
  const lock = path.join(dir, `${h}.lock`);
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmdirSync(lock); // crashed holder
          continue;
        }
      } catch {}
      if (Date.now() - start > LOCK_WAIT_MS) throw new Error("lock timeout");
      sleep(5 + Math.random() * 15);
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
    return JSON.parse(fs.readFileSync(file, "utf8")).reservations || [];
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

function save(file, reservations) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ reservations }));
  fs.renameSync(tmp, file);
}

function posInt(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid ${name}`);
  return n;
}

export function reserve(request, now) {
  const { userId } = request || {};
  if (userId === undefined || userId === null || userId === "") throw new Error("userId required");
  const max = posInt(request.maxPerWindow, "maxPerWindow");
  const windowMs = posInt(request.windowHours, "windowHours") * 3600000;
  const gapMs = posInt(request.minGapMinutes, "minGapMinutes") * 60000;
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(t)) throw new Error("invalid now");

  const dir = stateDir();
  const h = hashUser(userId);
  const file = path.join(dir, `${h}.json`);
  return withLock(dir, h, () => {
    const list = load(file).filter((r) => t - r.at < KEEP_MS);
    const last = list.reduce((m, r) => Math.max(m, r.at), -Infinity);
    const inWindow = list.filter((r) => t - r.at < windowMs && r.at <= t + windowMs).length;

    let reason = null;
    if (list.length && t - last < gapMs) reason = "min_gap_not_elapsed";
    else if (inWindow >= max) reason = "max_per_window_reached";
    if (reason) {
      return { allowed: false, reason, reservationId: null };
    }
    const id = `${h}-${crypto.randomUUID()}`;
    list.push({ id, at: t });
    save(file, list);
    return { allowed: true, reason: null, reservationId: id };
  });
}

export function release(reservationId) {
  const m = /^([0-9a-f]{32})-[0-9a-f-]{36}$/.exec(String(reservationId));
  if (!m) return false;
  const dir = stateDir();
  const h = m[1];
  const file = path.join(dir, `${h}.json`);
  return withLock(dir, h, () => {
    const list = load(file);
    const next = list.filter((r) => r.id !== reservationId);
    if (next.length === list.length) return false; // unknown or already released
    save(file, next);
    return true;
  });
}
