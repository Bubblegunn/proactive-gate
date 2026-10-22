import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const HOUR = 3600_000;
const MINUTE = 60_000;
const RETAIN_MS = 30 * 24 * HOUR;
const LOCK_STALE_MS = 15_000;

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR is not set");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// Cross-process mutex: mkdir is atomic. A lock left by a dead process is removed.
async function withLock(dir, fn) {
  const lock = join(dir, "state.lock");
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      mkdirSync(lock);
      try { writeFileSync(join(lock, "pid"), String(process.pid)); } catch {}
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    try {
      const age = Date.now() - statSync(lock).mtimeMs;
      let owner = NaN;
      try { owner = Number(readFileSync(join(lock, "pid"), "utf8")); } catch {}
      const dead = Number.isInteger(owner) && owner > 0 && !pidAlive(owner);
      if (dead || age > LOCK_STALE_MS) {
        // rename is atomic: only one contender wins the right to clear it
        const grave = `${lock}.stale.${randomUUID()}`;
        try { renameSync(lock, grave); rmSync(grave, { recursive: true, force: true }); } catch {}
        continue;
      }
    } catch {}
    if (Date.now() > deadline) throw new Error("timed out waiting for rate limiter lock");
    await sleep(5 + Math.random() * 15);
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function load(file) {
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    return s && typeof s === "object" && s.users ? s : { users: {} };
  } catch (e) {
    if (e.code === "ENOENT") return { users: {} };
    throw e; // never silently reset history on a corrupt file
  }
}

function save(file, state) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, file);
}

export async function reserve(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request;
  const t = now.getTime();
  const dir = stateDir();
  const file = join(dir, "reservations.json");
  return withLock(dir, () => {
    const state = load(file);
    const horizon = t - Math.max(RETAIN_MS, windowHours * HOUR);
    for (const [u, list] of Object.entries(state.users)) {
      const kept = list.filter((r) => r.at > horizon);
      if (kept.length) state.users[u] = kept; else delete state.users[u];
    }
    const list = state.users[userId] || [];
    // Only live (unreleased) reservations are stored, so every entry counts.
    // Sliding window: a slot frees exactly windowHours after its own send.
    const windowStart = t - windowHours * HOUR;
    const inWindow = list.filter((r) => r.at > windowStart);
    let reason = null;
    if (minGapMinutes > 0 && list.some((r) => Math.abs(t - r.at) < minGapMinutes * MINUTE)) {
      reason = "min_gap";
    } else if (inWindow.length >= maxPerWindow) {
      reason = "window_limit";
    }
    if (reason) {
      save(file, state); // persist pruning only
      return { allowed: false, reason, reservationId: null };
    }
    const id = randomUUID();
    list.push({ id, at: t });
    state.users[userId] = list;
    save(file, state);
    return { allowed: true, reason: null, reservationId: id };
  });
}

export async function release(reservationId) {
  if (!reservationId) return;
  const dir = stateDir();
  const file = join(dir, "reservations.json");
  return withLock(dir, () => {
    const state = load(file);
    for (const [u, list] of Object.entries(state.users)) {
      const kept = list.filter((r) => r.id !== reservationId);
      if (kept.length !== list.length) {
        if (kept.length) state.users[u] = kept; else delete state.users[u];
        save(file, state);
        return;
      }
    }
  });
}
