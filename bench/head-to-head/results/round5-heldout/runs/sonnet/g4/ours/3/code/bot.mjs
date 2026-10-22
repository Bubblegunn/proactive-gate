// Shared per-lead send limiter. All state lives in STATE_DIR (read on every call).
// One JSON file per lead, guarded by an mkdir lock; writes are temp file + rename.
import { mkdir, readFile, writeFile, rename, rmdir, stat, unlink } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

const MIN = 60_000;
const HOUR = 3_600_000;
const KEEP_MS = 90 * 24 * HOUR; // history kept at least this long
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 20_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hashOf = (userId) => createHash("sha256").update(userId).digest("hex").slice(0, 32);

async function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR is not set");
  const d = path.join(dir, "send-limiter");
  await mkdir(d, { recursive: true });
  return d;
}

async function withLock(dir, key, fn) {
  const lock = path.join(dir, `${key}.lock`);
  const start = Date.now();
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const s = await stat(lock);
        if (Date.now() - s.mtimeMs > LOCK_STALE_MS) {
          const gone = `${lock}.stale-${randomBytes(4).toString("hex")}`;
          await rename(lock, gone).then(() => rmdir(gone)).catch(() => {});
          continue;
        }
      } catch {}
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error("limiter lock timeout");
      await sleep(5 + Math.random() * 15);
    }
  }
  try {
    return await fn();
  } finally {
    await rmdir(lock).catch(() => {});
  }
}

async function load(file) {
  try {
    const j = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(j.reservations) ? j : { reservations: [] };
  } catch (e) {
    if (e.code === "ENOENT") return { reservations: [] };
    throw e;
  }
}

async function save(file, data) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

const deny = (reason) => ({ allowed: false, reason, reservationId: null });

export async function reserve(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request ?? {};
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (typeof userId !== "string" || userId === "" || !Number.isFinite(t) ||
      !Number.isFinite(maxPerWindow) || maxPerWindow < 0 ||
      !Number.isFinite(windowHours) || windowHours < 0 ||
      !Number.isFinite(minGapMinutes) || minGapMinutes < 0) {
    return deny("invalid_request");
  }
  const dir = await stateDir();
  const key = hashOf(userId);
  const file = path.join(dir, `${key}.json`);
  return withLock(dir, key, async () => {
    const data = await load(file);
    const windowMs = windowHours * HOUR;
    const gapMs = minGapMinutes * MIN;
    // Sliding window: a slot counts until exactly windowHours after it was reserved.
    const inWindow = data.reservations.filter((r) => r.at > t - windowMs);
    if (inWindow.length >= maxPerWindow) return deny("window_limit");
    const last = data.reservations.reduce((m, r) => Math.max(m, r.at), -Infinity);
    if (t - last < gapMs) return deny("min_gap");

    const id = `${key}.${randomBytes(12).toString("hex")}`;
    const horizon = t - Math.max(KEEP_MS, windowMs, gapMs);
    data.reservations = data.reservations.filter((r) => r.at > horizon);
    data.reservations.push({ id, at: t });
    await save(file, data);
    return { allowed: true, reason: null, reservationId: id };
  });
}

export async function release(reservationId) {
  if (typeof reservationId !== "string") return;
  const m = /^([0-9a-f]{32})\.[0-9a-f]{24}$/.exec(reservationId);
  if (!m) return;
  const dir = await stateDir();
  const file = path.join(dir, `${m[1]}.json`);
  await withLock(dir, m[1], async () => {
    const data = await load(file);
    const next = data.reservations.filter((r) => r.id !== reservationId);
    if (next.length !== data.reservations.length) await save(file, { reservations: next });
  });
}
