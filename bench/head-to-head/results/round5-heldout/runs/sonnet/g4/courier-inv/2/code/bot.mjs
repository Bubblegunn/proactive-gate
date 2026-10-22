// Shared send rate limiter. All workers coordinate through STATE_DIR:
// one JSON ledger of active reservations, guarded by an exclusive lock file.
//
// Semantics (chosen for what the recipient experiences):
// - Only reservations that still stand count. A released slot (message never
//   delivered) is deleted, so it counts toward nothing. A refused request
//   never creates a record, so refusals do not extend any limit.
// - The window is rolling: a reservation counts while its time is after
//   now - windowHours. It does not reset at midnight or at a fixed boundary.
// - The minimum gap is measured from the most recent standing reservation.
// - Limits come from each call, so every call re-evaluates the shared history
//   with its own limits.
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const LEDGER = "reservations.json";
const LOCK = "ledger.lock";
const LOCK_STALE_MS = 15_000;
const RETAIN_MS = 45 * 24 * 3600 * 1000; // longer than any plausible window

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR is not set");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function withLock(dir, fn) {
  const lockPath = path.join(dir, LOCK);
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const fh = await fs.open(lockPath, "wx");
      await fh.writeFile(token);
      await fh.close();
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const st = await fs.stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          // Break a stale lock by renaming it away; only one breaker wins.
          await fs.rename(lockPath, `${lockPath}.stale.${randomUUID()}`).then(
            () => undefined,
            () => undefined,
          );
          continue;
        }
      } catch {
        continue; // lock vanished; retry immediately
      }
      if (Date.now() > deadline) throw new Error("timeout waiting for rate limiter lock");
      await sleep(5 + Math.random() * 15);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      // Remove only if still ours.
      if ((await fs.readFile(lockPath, "utf8")) === token) await fs.unlink(lockPath);
    } catch {}
  }
}

async function readLedger(dir) {
  try {
    const data = JSON.parse(await fs.readFile(path.join(dir, LEDGER), "utf8"));
    return Array.isArray(data.reservations) ? data.reservations : [];
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e; // corrupt ledger: fail loudly rather than allow unlimited sends
  }
}

async function writeLedger(dir, reservations) {
  const tmp = path.join(dir, `${LEDGER}.${process.pid}.${randomUUID()}.tmp`);
  const fh = await fs.open(tmp, "w");
  try {
    await fh.writeFile(JSON.stringify({ reservations }));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, path.join(dir, LEDGER));
}

function checkRequest(r) {
  const posNum = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (!r || typeof r.userId !== "string" || !r.userId) throw new TypeError("userId required");
  if (!Number.isInteger(r.maxPerWindow) || r.maxPerWindow < 0) throw new TypeError("bad maxPerWindow");
  if (!posNum(r.windowHours)) throw new TypeError("bad windowHours");
  if (!posNum(r.minGapMinutes)) throw new TypeError("bad minGapMinutes");
}

export async function reserve(request, now) {
  checkRequest(request);
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(t)) throw new TypeError("bad now");
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request;
  const dir = await stateDir();

  return withLock(dir, async () => {
    const all = (await readLedger(dir)).filter((x) => t - x.at < RETAIN_MS);
    const mine = all.filter((x) => x.userId === userId);

    const cutoff = t - windowHours * 3600_000;
    const inWindow = mine.filter((x) => x.at > cutoff);
    let result;
    if (inWindow.length >= maxPerWindow) {
      result = { allowed: false, reason: "window_limit_reached", reservationId: null };
    } else if (
      mine.length > 0 &&
      // |t - at| so a caller clock slightly behind another worker's also counts as too close
      Math.min(...mine.map((x) => Math.abs(t - x.at))) < minGapMinutes * 60_000
    ) {
      result = { allowed: false, reason: "min_gap_not_elapsed", reservationId: null };
    } else {
      const id = randomUUID();
      all.push({ id, userId, at: t });
      result = { allowed: true, reason: null, reservationId: id };
    }
    await writeLedger(dir, all);
    return result;
  });
}

export async function release(reservationId) {
  if (typeof reservationId !== "string" || !reservationId) return;
  const dir = await stateDir();
  await withLock(dir, async () => {
    const all = await readLedger(dir);
    const rest = all.filter((x) => x.id !== reservationId);
    if (rest.length !== all.length) await writeLedger(dir, rest);
  });
}
