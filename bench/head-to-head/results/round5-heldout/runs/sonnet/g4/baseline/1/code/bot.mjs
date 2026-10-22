// Shared send-slot rate limiter for proactive lead messages.
// State: one JSON file per lead in STATE_DIR, guarded by a per-lead lock file,
// so every worker process on the machine sees the same history and restarts lose nothing.
//
// Semantics:
//  - Sliding window: a slot counts while its time is within the last windowHours of `now`.
//  - Only slots that were reserved and not released count (a released slot was never delivered).
//  - Minimum gap is measured from the most recent live slot, even if that slot is older than the window.
//  - Limits come from each call, so history is kept long enough for any plausible window.
import { mkdir, readFile, writeFile, rename, unlink, stat, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

const HOUR = 3600_000;
const MINUTE = 60_000;
const KEEP_MS = 90 * 24 * HOUR; // never prune younger than this, nor younger than the call's window
const LOCK_STALE_MS = 15_000;
const LOCK_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

const userKey = (userId) => createHash('sha256').update(userId).digest('hex').slice(0, 32);

async function withLock(dir, key, fn) {
  await mkdir(dir, { recursive: true });
  const lockPath = join(dir, `${key}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    let fh;
    try {
      fh = await open(lockPath, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          // holder crashed; only one breaker wins the rename
          const grave = `${lockPath}.stale.${randomUUID()}`;
          await rename(lockPath, grave).then(() => unlink(grave).catch(() => {}), () => {});
          continue;
        }
      } catch (e2) {
        if (e2.code === 'ENOENT') continue;
        throw e2;
      }
      if (Date.now() > deadline) throw new Error('timed out waiting for rate-limit lock');
      await sleep(2 + Math.random() * 15);
      continue;
    }
    await fh.close();
    try {
      return await fn();
    } finally {
      await unlink(lockPath).catch(() => {});
    }
  }
}

async function load(file) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(data.slots) ? data.slots : [];
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e; // corrupt state: fail loudly rather than allow unlimited sends
  }
}

async function save(file, slots) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify({ slots }));
  await rename(tmp, file);
}

function validate(r) {
  const bad = (m) => { throw new TypeError(`invalid request: ${m}`); };
  if (!r || typeof r.userId !== 'string' || r.userId === '') bad('userId');
  if (!Number.isInteger(r.maxPerWindow) || r.maxPerWindow < 0) bad('maxPerWindow');
  if (!(r.windowHours > 0) || !Number.isFinite(r.windowHours)) bad('windowHours');
  if (!(r.minGapMinutes >= 0) || !Number.isFinite(r.minGapMinutes)) bad('minGapMinutes');
}

export async function reserve(request, now) {
  validate(request);
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(t)) throw new TypeError('invalid now');
  const dir = stateDir();
  const key = userKey(request.userId);
  const file = join(dir, `${key}.json`);
  const windowMs = request.windowHours * HOUR;
  const gapMs = request.minGapMinutes * MINUTE;

  return withLock(dir, key, async () => {
    let slots = await load(file);
    const keepFrom = t - Math.max(KEEP_MS, windowMs);
    const pruned = slots.filter((s) => s.at > keepFrom);

    // slots at or after window start (including ones stamped slightly in the future by another clock)
    const inWindow = pruned.filter((s) => s.at > t - windowMs);
    if (inWindow.length >= request.maxPerWindow) {
      if (pruned.length !== slots.length) await save(file, pruned);
      return { allowed: false, reason: 'window_limit', reservationId: null };
    }
    if (gapMs > 0 && pruned.some((s) => Math.abs(t - s.at) < gapMs)) {
      if (pruned.length !== slots.length) await save(file, pruned);
      return { allowed: false, reason: 'min_gap', reservationId: null };
    }
    const id = `${key}.${randomUUID()}`;
    pruned.push({ id, at: t });
    await save(file, pruned);
    return { allowed: true, reason: null, reservationId: id };
  });
}

export async function release(reservationId) {
  if (typeof reservationId !== 'string') return false;
  const m = /^([0-9a-f]{32})\.[0-9a-f-]{36}$/.exec(reservationId);
  if (!m) return false;
  const dir = stateDir();
  const key = m[1];
  const file = join(dir, `${key}.json`);
  return withLock(dir, key, async () => {
    const slots = await load(file);
    const rest = slots.filter((s) => s.id !== reservationId);
    if (rest.length === slots.length) return false; // unknown or already released
    await save(file, rest);
    return true;
  });
}
