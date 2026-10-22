import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Shared per-lead send limiter. One JSON file per lead in STATE_DIR, guarded by
// an mkdir lock so ~12 worker processes cannot both claim the same slot.
// Window is sliding: a slot counts for windowHours after its reservation time.
// A slot older than the window (exactly windowHours old or more) no longer counts.
// Released slots are deleted, so they count toward nothing.

const KEEP_MS = 45 * 24 * 3600 * 1000;
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = (s) => Buffer.from(s, "utf8").toString("base64url");
const dec = (s) => Buffer.from(s, "base64url").toString("utf8");

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR is not set");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function withLock(file, fn) {
  const lock = file + ".lock";
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {}
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error("lock timeout");
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
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(d.slots) ? d.slots : [];
  } catch {
    return [];
  }
}

function save(file, slots) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ slots }));
  fs.renameSync(tmp, file);
}

const deny = (reason) => ({ allowed: false, reason, reservationId: null });

export async function reserve(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request ?? {};
  const t = now instanceof Date ? now.getTime() : NaN;
  if (typeof userId !== "string" || userId === "" || Number.isNaN(t)) return deny("invalid_request");
  if (!Number.isFinite(maxPerWindow) || maxPerWindow < 0) return deny("invalid_request");
  if (!Number.isFinite(windowHours) || windowHours <= 0) return deny("invalid_request");
  if (!Number.isFinite(minGapMinutes) || minGapMinutes < 0) return deny("invalid_request");

  const file = path.join(stateDir(), `lead-${enc(userId)}.json`);
  const windowMs = windowHours * 3600 * 1000;
  const gapMs = minGapMinutes * 60 * 1000;

  return withLock(file, () => {
    const slots = load(file).filter((s) => Math.abs(t - s.at) < KEEP_MS);
    const inWindow = slots.filter((s) => s.at > t - windowMs);

    // Earliest time each limit would let this send through.
    let capRetry = -Infinity;
    if (inWindow.length >= maxPerWindow) {
      const sorted = inWindow.map((s) => s.at).sort((a, b) => a - b);
      capRetry = sorted[sorted.length - maxPerWindow] + windowMs;
    }
    let gapRetry = -Infinity;
    for (const s of slots) {
      if (Math.abs(t - s.at) < gapMs) gapRetry = Math.max(gapRetry, s.at + gapMs);
    }

    if (capRetry > t || gapRetry > t) {
      // Name the limit that clears last: waiting out the other would not help.
      return deny(capRetry >= gapRetry ? "max_per_window" : "min_gap");
    }

    const id = `${enc(userId)}.${randomUUID()}`;
    slots.push({ id, at: t });
    save(file, slots);
    return { allowed: true, reason: null, reservationId: id };
  });
}

export async function release(reservationId) {
  if (typeof reservationId !== "string") return false;
  const i = reservationId.indexOf(".");
  if (i < 1) return false;
  let userId;
  try {
    userId = dec(reservationId.slice(0, i));
  } catch {
    return false;
  }
  const file = path.join(stateDir(), `lead-${enc(userId)}.json`);
  if (!fs.existsSync(file)) return false;
  return withLock(file, () => {
    const slots = load(file);
    const rest = slots.filter((s) => s.id !== reservationId);
    if (rest.length === slots.length) return false;
    save(file, rest);
    return true;
  });
}
