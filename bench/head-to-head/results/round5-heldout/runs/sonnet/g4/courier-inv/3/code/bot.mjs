// Shared per-lead send limiter. State lives in STATE_DIR so every worker sees it
// and it survives restarts. One JSON file per lead, guarded by a mkdir lock.
//
// Semantics:
// - Rolling window: a slot counts while (now - reservedAt) < windowHours, so a
//   lead never receives more than maxPerWindow messages in ANY span of that length.
// - Min gap is measured from the most recent active reservation (either direction,
//   to tolerate small clock differences between callers).
// - Released reservations stop counting immediately (the lead never got the message).
// - Both limits can apply; window_limit is reported first.
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 60_000;
const RETENTION_MS = 31 * 24 * 3600 * 1000; // drop entries older than this

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = (s) => Buffer.from(s, "utf8").toString("base64url");
const dec = (s) => Buffer.from(s, "base64url").toString("utf8");

function stateDir() {
  const d = process.env.STATE_DIR;
  if (!d) throw new Error("STATE_DIR is not set");
  return d;
}

async function withLock(file, fn) {
  const lock = file + ".lock";
  const start = Date.now();
  for (;;) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fs.rmdir(lock).catch(() => {});
          continue;
        }
      } catch {
        continue; // lock vanished
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error("lock timeout");
      await sleep(5 + Math.random() * 15);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rmdir(lock).catch(() => {});
  }
}

async function load(file) {
  try {
    const data = JSON.parse(await fs.readFile(file, "utf8"));
    return Array.isArray(data.reservations) ? data.reservations : [];
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

async function save(file, reservations) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ reservations }));
  await fs.rename(tmp, file);
}

function fileFor(dir, userId) {
  return path.join(dir, `lead-${enc(userId)}.json`);
}

export async function reserve(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request ?? {};
  if (typeof userId !== "string" || userId === "") throw new TypeError("userId required");
  if (!Number.isFinite(maxPerWindow) || maxPerWindow < 0) throw new TypeError("bad maxPerWindow");
  if (!Number.isFinite(windowHours) || windowHours <= 0) throw new TypeError("bad windowHours");
  if (!Number.isFinite(minGapMinutes) || minGapMinutes < 0) throw new TypeError("bad minGapMinutes");
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(t)) throw new TypeError("bad now");

  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const file = fileFor(dir, userId);
  const windowMs = windowHours * 3600 * 1000;
  const gapMs = minGapMinutes * 60 * 1000;

  return withLock(file, async () => {
    const all = (await load(file)).filter((r) => t - r.at < RETENTION_MS);
    const inWindow = all.filter((r) => r.at > t - windowMs && r.at <= t + windowMs);
    if (inWindow.length >= maxPerWindow) {
      await save(file, all);
      return { allowed: false, reason: "window_limit", reservationId: null };
    }
    if (all.some((r) => Math.abs(t - r.at) < gapMs)) {
      await save(file, all);
      return { allowed: false, reason: "min_gap", reservationId: null };
    }
    const id = `${enc(userId)}.${randomBytes(12).toString("hex")}`;
    all.push({ id, at: t });
    await save(file, all);
    return { allowed: true, reason: null, reservationId: id };
  });
}

export async function release(reservationId) {
  if (typeof reservationId !== "string") return;
  const dot = reservationId.indexOf(".");
  if (dot < 1) return;
  let userId;
  try {
    userId = dec(reservationId.slice(0, dot));
  } catch {
    return;
  }
  const file = fileFor(stateDir(), userId);
  await withLock(file, async () => {
    const all = await load(file);
    const rest = all.filter((r) => r.id !== reservationId);
    if (rest.length !== all.length) await save(file, rest); // unknown/already released: no-op
  });
}
