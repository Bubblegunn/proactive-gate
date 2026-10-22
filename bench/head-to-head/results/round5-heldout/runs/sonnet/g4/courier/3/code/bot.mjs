// Shared send-rate limiter for lead follow-ups. State lives in STATE_DIR, one JSON file per lead,
// guarded by a per-lead lock file so any number of worker processes can call it safely.
//
// Semantics:
// - Sliding window: a reservation counts while (now - reservedAt) < windowHours. No fixed buckets,
//   so a lead never receives more than maxPerWindow messages in ANY windowHours span.
// - Min gap: blocked while (now - latest reservation) < minGapMinutes. A reservation timestamped
//   in the future (clock skew between callers) also blocks.
// - Denied calls consume nothing. Released reservations stop counting for both limits.
// - Reasons: "window_limit_reached", "min_gap_not_elapsed".

import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

const RETAIN_MS = 90 * 24 * 3600 * 1000;
const LOCK_STALE_MS = 15000;

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR is not set");
  return dir;
}

const keyOf = (userId) => createHash("sha256").update(String(userId)).digest("hex").slice(0, 32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

async function withLock(dir, key, fn) {
  const lock = path.join(dir, `${key}.lock`);
  const token = `${process.pid}:${randomUUID()}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const fh = await fs.open(lock, "wx");
      await fh.writeFile(token);
      await fh.close();
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const st = await fs.stat(lock);
        let owner = NaN;
        try { owner = parseInt(await fs.readFile(lock, "utf8"), 10); } catch {}
        const dead = Number.isFinite(owner) && !pidAlive(owner);
        if (dead || Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          const grave = `${lock}.stale.${randomUUID()}`;
          await fs.rename(lock, grave).catch(() => {});
          await fs.unlink(grave).catch(() => {});
          continue;
        }
      } catch {}
      if (attempt > 6000) throw new Error("could not acquire rate-limit lock");
      await sleep(2 + Math.random() * 8);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      if ((await fs.readFile(lock, "utf8")) === token) await fs.unlink(lock);
    } catch {}
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
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const fh = await fs.open(tmp, "w");
  await fh.writeFile(JSON.stringify({ reservations }));
  await fh.sync();
  await fh.close();
  await fs.rename(tmp, file);
}

export async function reserve(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request;
  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const key = keyOf(userId);
  const file = path.join(dir, `${key}.json`);
  const t = now.getTime();

  return withLock(dir, key, async () => {
    const all = (await load(file)).filter((r) => t - r.at < RETAIN_MS);
    const windowMs = windowHours * 3600 * 1000;
    const gapMs = minGapMinutes * 60 * 1000;

    const inWindow = all.filter((r) => t - r.at < windowMs);
    if (inWindow.length >= maxPerWindow) {
      return { allowed: false, reason: "window_limit_reached", reservationId: null };
    }
    const latest = all.reduce((m, r) => Math.max(m, r.at), -Infinity);
    if (all.length && t - latest < gapMs) {
      return { allowed: false, reason: "min_gap_not_elapsed", reservationId: null };
    }
    const id = `${key}.${randomUUID()}`;
    all.push({ id, at: t });
    await save(file, all);
    return { allowed: true, reason: null, reservationId: id };
  });
}

export async function release(reservationId) {
  const key = String(reservationId ?? "").split(".")[0];
  if (!/^[0-9a-f]{32}$/.test(key)) return false;
  const dir = stateDir();
  const file = path.join(dir, `${key}.json`);
  try { await fs.access(file); } catch { return false; }
  return withLock(dir, key, async () => {
    const all = await load(file);
    const rest = all.filter((r) => r.id !== reservationId);
    if (rest.length === all.length) return false; // unknown or already released
    await save(file, rest);
    return true;
  });
}
