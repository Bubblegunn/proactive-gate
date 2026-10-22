import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Shared send-slot limiter. State lives in STATE_DIR, one JSON file per lead,
// guarded by a per-lead lock directory so all worker processes agree.
//
// Semantics:
// - Only active reservations count. Denied attempts are not recorded, and
//   released reservations are deleted (the lead never received that message).
// - Sliding window: a slot made at time t counts while t > now - windowHours.
// - Min gap: denied if any active reservation is within minGapMinutes of now.
// - Reasons: "window_limit" (max per window reached), "min_gap" (too soon).
//   If both apply, "window_limit" is returned (it takes longer to clear).

const HOUR = 3600_000;
const MINUTE = 60_000;
const RETENTION_MS = 30 * 24 * HOUR;
const LOCK_STALE_MS = 10_000;

const stateDir = () => {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR is not set");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const userHash = (userId) =>
  crypto.createHash("sha256").update(userId).digest("hex").slice(0, 40);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withLock(dir, hash, fn) {
  const lock = path.join(dir, `${hash}.lock`);
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          // Atomic rename: only one contender wins the right to clear it.
          const grave = `${lock}.dead-${process.pid}-${crypto.randomUUID()}`;
          fs.renameSync(lock, grave);
          fs.rmSync(grave, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // lock vanished or was taken by another contender
      }
      if (Date.now() > deadline) throw new Error("timed out waiting for lock");
      await sleep(5 + Math.random() * 15);
    }
  }
  try {
    return await fn();
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
    throw e;
  }
}

function save(file, userId, slots) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ userId, slots }));
  fs.renameSync(tmp, file);
}

function check(request) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request ?? {};
  if (typeof userId !== "string" || userId === "") throw new Error("userId required");
  if (!Number.isFinite(maxPerWindow) || maxPerWindow < 0) throw new Error("bad maxPerWindow");
  if (!Number.isFinite(windowHours) || windowHours < 0) throw new Error("bad windowHours");
  if (!Number.isFinite(minGapMinutes) || minGapMinutes < 0) throw new Error("bad minGapMinutes");
}

export async function reserve(request, now) {
  check(request);
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request;
  const t = (now instanceof Date ? now : new Date(now)).getTime();
  if (!Number.isFinite(t)) throw new Error("bad now");
  const dir = stateDir();
  const hash = userHash(userId);
  const file = path.join(dir, `${hash}.json`);

  return withLock(dir, hash, () => {
    const all = load(file).filter((s) => s.at > t - RETENTION_MS);
    const inWindow = all.filter((s) => s.at > t - windowHours * HOUR);
    let reason = null;
    if (inWindow.length >= maxPerWindow) reason = "window_limit";
    else if (all.some((s) => Math.abs(t - s.at) < minGapMinutes * MINUTE)) reason = "min_gap";

    if (reason) {
      return { allowed: false, reason, reservationId: null };
    }
    const id = `${hash}.${crypto.randomUUID()}`;
    all.push({ id, at: t });
    save(file, userId, all);
    return { allowed: true, reason: null, reservationId: id };
  });
}

export async function release(reservationId) {
  const m = /^([0-9a-f]{40})\.[0-9a-f-]{36}$/.exec(String(reservationId ?? ""));
  if (!m) return;
  const dir = stateDir();
  const hash = m[1];
  const file = path.join(dir, `${hash}.json`);
  await withLock(dir, hash, () => {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return;
      throw e;
    }
    const slots = (data.slots ?? []).filter((s) => s.id !== reservationId);
    if (slots.length !== (data.slots ?? []).length) save(file, data.userId, slots);
  });
}
