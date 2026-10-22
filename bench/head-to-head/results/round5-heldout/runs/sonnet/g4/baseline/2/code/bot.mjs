import { mkdir, rename, rm, readFile, writeFile, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

// Shared send rate limiter. One JSON history file per lead in STATE_DIR,
// guarded by a per-lead lock directory (mkdir is atomic across processes).
//
// Semantics:
// - Only active reservations count. A refused request is not recorded, and a
//   released reservation is deleted, so it frees both window and gap capacity.
// - The window is rolling: a slot counts while (now - reservedAt) < windowHours.
// - The gap is measured from the most recent active reservation.
// - Limits come from each call, so the history stores timestamps only.

const LOCK_STALE_MS = 30_000;
const KEEP_MS = 60 * 24 * 3600 * 1000; // drop history older than 60 days
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stateDir() {
  const d = process.env.STATE_DIR;
  if (!d) throw new Error("STATE_DIR is not set");
  return d;
}

const leadKey = (userId) => createHash("sha256").update(String(userId)).digest("hex").slice(0, 32);

async function withLock(key, fn) {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const lock = join(dir, `${key}.lock`);
  for (let i = 0; ; i++) {
    try {
      await mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const s = await stat(lock);
        if (Date.now() - s.mtimeMs > LOCK_STALE_MS) {
          // holder crashed; only one contender's rename can succeed
          await rename(lock, `${lock}.stale-${randomUUID()}`).then(
            (p) => p,
            () => {},
          );
          continue;
        }
      } catch {}
      await sleep(5 + Math.random() * 20);
    }
  }
  try {
    return await fn(join(dir, `${key}.json`));
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function load(file) {
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(data.slots) ? data.slots : [];
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e; // corrupt file: fail loudly rather than reset the history
  }
}

async function save(file, slots) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify({ slots }));
  await rename(tmp, file);
}

function positive(v, name) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`invalid ${name}`);
  return v;
}

export async function reserve(request, now) {
  const { userId } = request;
  if (userId === undefined || userId === null || userId === "") throw new Error("invalid userId");
  const max = positive(request.maxPerWindow, "maxPerWindow");
  const windowMs = positive(request.windowHours, "windowHours") * 3600_000;
  const gapMs = positive(request.minGapMinutes, "minGapMinutes") * 60_000;
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(t)) throw new Error("invalid now");

  const key = leadKey(userId);
  return withLock(key, async (file) => {
    const all = await load(file);
    const slots = all.filter((s) => s.at > t - KEEP_MS);

    // A slot dated after `now` (clock skew between workers) still counts.
    const inWindow = slots.filter((s) => t - s.at < windowMs);
    const last = slots.reduce((m, s) => Math.max(m, s.at), -Infinity);

    let reason = null;
    if (slots.length && gapMs > 0 && t - last < gapMs) reason = "min_gap";
    else if (inWindow.length >= max) reason = "window_limit";

    if (reason) {
      if (slots.length !== all.length) await save(file, slots);
      return { allowed: false, reason, reservationId: null };
    }
    const id = `${key}-${randomUUID()}`;
    slots.push({ id, at: t });
    await save(file, slots);
    return { allowed: true, reason: null, reservationId: id };
  });
}

export async function release(reservationId) {
  const key = typeof reservationId === "string" ? reservationId.split("-")[0] : "";
  if (!/^[0-9a-f]{32}$/.test(key)) return false;
  return withLock(key, async (file) => {
    const slots = await load(file);
    const rest = slots.filter((s) => s.id !== reservationId);
    if (rest.length === slots.length) return false; // unknown or already released
    await save(file, rest);
    return true;
  });
}
