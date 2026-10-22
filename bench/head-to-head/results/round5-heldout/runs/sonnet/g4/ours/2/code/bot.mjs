import { mkdir, readFile, writeFile, rename, rmdir, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

// Rate limiter for proactive messages. One JSON file per lead in STATE_DIR,
// guarded by a mkdir lock so several worker processes cannot both win.
// Window is rolling: a slot counts for windowHours after its reservation time.
// A released slot stops counting for both the window cap and the minimum gap.

const KEEP_MS = 90 * 24 * 3600 * 1000;
const LOCK_STALE_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (s) => createHash("sha256").update(s).digest("hex");

async function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR is not set");
  await mkdir(dir, { recursive: true });
  return dir;
}

async function withLock(dir, userId, fn) {
  const base = join(dir, `lead-${sha(userId)}`);
  const lock = base + ".lock";
  for (let i = 0; ; i++) {
    try {
      await mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const st = await stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          // Break a lock left by a crashed worker; rename is atomic so only one breaker wins.
          const dead = `${lock}.dead-${randomUUID()}`;
          await rename(lock, dead).then(() => rmdir(dead)).catch(() => {});
          continue;
        }
      } catch {}
      await sleep(5 + Math.random() * 20);
    }
  }
  try {
    return await fn(base + ".json");
  } finally {
    await rmdir(lock).catch(() => {});
  }
}

async function load(file) {
  try {
    const d = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(d.slots) ? d.slots : [];
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

async function save(file, slots) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify({ slots }));
  await rename(tmp, file);
}

const deny = (reason) => ({ allowed: false, reason, reservationId: null });
const posNum = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;

export async function reserve(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request ?? {};
  const t = now instanceof Date ? now.getTime() : NaN;
  if (typeof userId !== "string" || !userId || !Number.isFinite(t) ||
      !posNum(maxPerWindow) || !posNum(windowHours) || !posNum(minGapMinutes)) {
    return deny("invalid_request");
  }
  const dir = await stateDir();
  return withLock(dir, userId, async (file) => {
    const slots = (await load(file)).filter((s) => t - s.at < KEEP_MS);
    const windowMs = windowHours * 3600_000;
    const gapMs = minGapMinutes * 60_000;
    // Slots dated after `now` (another worker's clock ahead) still count.
    const inWindow = slots.filter((s) => s.at > t - windowMs);
    if (inWindow.length >= maxPerWindow) return deny("window_limit_reached");
    if (slots.some((s) => Math.abs(t - s.at) < gapMs)) return deny("min_gap_not_elapsed");
    const id = `${Buffer.from(userId).toString("base64url")}.${randomUUID()}`;
    slots.push({ id, at: t });
    await save(file, slots);
    return { allowed: true, reason: null, reservationId: id };
  });
}

export async function release(reservationId) {
  if (typeof reservationId !== "string") return false;
  const dot = reservationId.indexOf(".");
  if (dot < 1) return false;
  let userId;
  try {
    userId = Buffer.from(reservationId.slice(0, dot), "base64url").toString();
  } catch {
    return false;
  }
  const dir = await stateDir();
  return withLock(dir, userId, async (file) => {
    const slots = await load(file);
    const rest = slots.filter((s) => s.id !== reservationId);
    if (rest.length === slots.length) return false; // unknown or already released
    await save(file, rest);
    return true;
  });
}
