// Shared send-rate limiter for proactive lead messages.
//
// Behaviour:
// - Rolling window: a slot taken at time t counts against the cap while t > now - windowHours.
//   It is not a calendar-day bucket, so a lead can never get a burst across a midnight boundary.
// - Minimum gap: a new slot is refused if the latest active slot is less than minGapMinutes old.
// - A slot counts from the moment it is reserved (the send is about to happen), so concurrent
//   workers cannot both pass. release() removes the slot, so a message the lead never received
//   uses neither the cap nor the gap.
// - Limits come from each call, so they are applied to the stored history at call time.
// - Limits are per lead across channels (WhatsApp and SMS share one history): the lead
//   experiences one stream of messages from us.
// - State: one JSON file per lead in STATE_DIR, guarded by a per-lead lock file, written atomically.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const HOUR_MS = 3600 * 1000;
const MINUTE_MS = 60 * 1000;
const RETAIN_MS = 90 * 24 * HOUR_MS; // drop history older than this; longer than any sane window
const LOCK_STALE_MS = 30 * 1000;
const LOCK_TIMEOUT_MS = 20 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR is not set");
  return dir;
}

function leadKey(userId) {
  return createHash("sha256").update(userId).digest("hex").slice(0, 32);
}

function filesFor(key) {
  const dir = stateDir();
  return { dir, data: path.join(dir, `lead-${key}.json`), lock: path.join(dir, `lead-${key}.lock`) };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

async function breakIfStale(lock) {
  try {
    const st = await stat(lock);
    let holder = NaN;
    try {
      holder = parseInt(await readFile(lock, "utf8"), 10);
    } catch {}
    const dead = Number.isInteger(holder) && !pidAlive(holder);
    if (dead || Date.now() - st.mtimeMs > LOCK_STALE_MS) {
      // Take it over by renaming to a unique name; only one contender's rename can succeed.
      const aside = `${lock}.stale-${randomUUID()}`;
      await rename(lock, aside);
      await rm(aside, { force: true });
    }
  } catch {}
}

async function withLock(lock, fn) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      const fh = await open(lock, "wx");
      await fh.writeFile(String(process.pid));
      await fh.close();
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() > deadline) throw new Error("timed out waiting for lead lock");
      await breakIfStale(lock);
      await sleep(5 + Math.random() * 15 + Math.min(attempt, 20));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}

async function load(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed && Array.isArray(parsed.slots)) return parsed;
  } catch (e) {
    if (e.code !== "ENOENT") throw e; // corrupt data must not silently reset the history
  }
  return { slots: [] };
}

async function save(file, state) {
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, file);
}

function checkRequest(r) {
  if (!r || typeof r.userId !== "string" || r.userId === "") throw new TypeError("userId must be a non-empty string");
  if (!Number.isInteger(r.maxPerWindow) || r.maxPerWindow < 0) throw new TypeError("maxPerWindow must be an integer >= 0");
  if (!Number.isFinite(r.windowHours) || r.windowHours <= 0) throw new TypeError("windowHours must be > 0");
  if (!Number.isFinite(r.minGapMinutes) || r.minGapMinutes < 0) throw new TypeError("minGapMinutes must be >= 0");
}

export async function reserve(request, now) {
  checkRequest(request);
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(nowMs)) throw new TypeError("now must be a valid Date");

  const key = leadKey(request.userId);
  const f = filesFor(key);
  await mkdir(f.dir, { recursive: true });

  return withLock(f.lock, async () => {
    const state = await load(f.data);
    state.slots = state.slots.filter((s) => s.at > nowMs - RETAIN_MS);

    const windowMs = request.windowHours * HOUR_MS;
    const gapMs = request.minGapMinutes * MINUTE_MS;

    // Gap: measured from the most recent slot. A slot stamped later than `now` (clock skew
    // between workers) still counts as recent, so skew cannot be used to dodge the gap.
    const latest = state.slots.reduce((m, s) => Math.max(m, s.at), -Infinity);
    const inWindow = state.slots.filter((s) => s.at > nowMs - windowMs).length;

    let denied = null;
    if (gapMs > 0 && latest !== -Infinity && nowMs - latest < gapMs) denied = "min_gap_not_elapsed";
    else if (inWindow >= request.maxPerWindow) denied = "window_limit_reached";

    if (denied) {
      await save(f.data, state); // persists pruning only
      return { allowed: false, reason: denied, reservationId: null };
    }

    const reservationId = `${key}-${randomUUID()}`;
    state.slots.push({ id: reservationId, at: nowMs });
    await save(f.data, state);
    return { allowed: true, reason: null, reservationId };
  });
}

export async function release(reservationId) {
  const m = typeof reservationId === "string" && /^([0-9a-f]{32})-[0-9a-f-]{36}$/.exec(reservationId);
  if (!m) return false;
  const f = filesFor(m[1]);
  try {
    await stat(f.data);
  } catch {
    return false;
  }
  return withLock(f.lock, async () => {
    const state = await load(f.data);
    const before = state.slots.length;
    state.slots = state.slots.filter((s) => s.id !== reservationId);
    if (state.slots.length === before) return false; // unknown or already released: no-op
    await save(f.data, state);
    return true;
  });
}
