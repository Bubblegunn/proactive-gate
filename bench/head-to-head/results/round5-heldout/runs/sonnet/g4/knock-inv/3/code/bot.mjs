// Shared send-rate limiter for proactive lead messages.
// History lives in STATE_DIR, one JSON file per lead, guarded by an atomic mkdir lock,
// so every worker process sees the same history and it survives restarts.
//
// Semantics (what the recipient experiences):
// - Rolling window: a slot counts against the last `windowHours` before `now`, not a fixed calendar block.
// - A reservation counts as a send from the moment it is granted (concurrent workers must see it).
// - release() removes the slot completely: it no longer counts toward the window or the minimum gap.
// - Window limit is checked before the gap; reasons: "min_gap" and "window_limit".
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const LOCK_STALE_MS = 15_000;
const LOCK_TIMEOUT_MS = 30_000;
const KEEP_MS = 30 * 24 * 3600_000; // never prune entries younger than this
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stateDir() {
  const d = process.env.STATE_DIR;
  if (!d) throw new Error("STATE_DIR is not set");
  return d;
}

const leadKey = (userId) => crypto.createHash("sha256").update(String(userId)).digest("hex").slice(0, 32);

async function withLock(key, fn) {
  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const lock = path.join(dir, `${key}.lock`);
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
          const dead = `${lock}.dead.${process.pid}.${crypto.randomUUID()}`;
          await fs.rename(lock, dead).then(() => fs.rm(dead, { recursive: true, force: true }), () => {});
          continue;
        }
      } catch {}
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error("rate limiter lock timeout");
      await sleep(5 + Math.random() * 15);
    }
  }
  try {
    return await fn(path.join(dir, `${key}.json`));
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

async function load(file) {
  try {
    const data = JSON.parse(await fs.readFile(file, "utf8"));
    return Array.isArray(data.reservations) ? data.reservations : [];
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e; // corrupt history: fail rather than silently allow a burst
  }
}

async function save(file, reservations) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ reservations }));
  await fs.rename(tmp, file);
}

const isPos = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;

export async function reserve(request, now) {
  const deny = (reason) => ({ allowed: false, reason, reservationId: null });
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request ?? {};
  const t = now instanceof Date ? now.getTime() : NaN;
  if (userId == null || userId === "" || !Number.isFinite(t) ||
      !isPos(maxPerWindow) || !isPos(windowHours) || !isPos(minGapMinutes)) {
    return deny("invalid_request");
  }
  const windowMs = windowHours * 3600_000;
  const gapMs = minGapMinutes * 60_000;
  const key = leadKey(userId);

  return withLock(key, async (file) => {
    let list = await load(file);
    const cutoff = t - Math.max(windowMs, gapMs, KEEP_MS);
    const pruned = list.filter((r) => r.at > cutoff);
    const inWindow = pruned.filter((r) => r.at > t - windowMs);
    if (inWindow.length >= maxPerWindow) {
      if (pruned.length !== list.length) await save(file, pruned);
      return deny("window_limit");
    }
    // abs(): callers' clocks may differ slightly; a send "just after" now also counts as close.
    if (pruned.some((r) => Math.abs(t - r.at) < gapMs)) {
      if (pruned.length !== list.length) await save(file, pruned);
      return deny("min_gap");
    }
    const id = `${key}-${crypto.randomUUID()}`;
    pruned.push({ id, at: t });
    await save(file, pruned);
    return { allowed: true, reason: null, reservationId: id };
  });
}

export async function release(reservationId) {
  const m = typeof reservationId === "string" && /^([0-9a-f]{32})-[0-9a-f-]{36}$/.exec(reservationId);
  if (!m) return false;
  return withLock(m[1], async (file) => {
    const list = await load(file);
    const next = list.filter((r) => r.id !== reservationId);
    if (next.length === list.length) return false; // unknown or already released: no-op
    await save(file, next);
    return true;
  });
}
