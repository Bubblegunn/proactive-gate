// Shared per-lead send limiter. Every worker calls reserve() before sending
// and release() if the provider rejects the message. State lives in
// STATE_DIR/leads/<sha256(userId)>.json, guarded by a lock directory so
// workers on one machine cannot both win the last slot.

import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const LOCK_STALE_MS = 10_000; // a lock older than this belonged to a crashed worker
const LOCK_WAIT_MS = 15_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function leadsDir() {
  // Read per call, not at import, so a test or restart can change STATE_DIR.
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return join(dir, 'leads');
}

function leadPaths(key) {
  const dir = leadsDir();
  return { file: join(dir, `${key}.json`), lock: join(dir, `${key}.lock`) };
}

function validate(request, now) {
  if (!request || typeof request.userId !== 'string' || request.userId === '') {
    throw new TypeError('userId must be a non-empty string');
  }
  if (!Number.isInteger(request.maxPerWindow) || request.maxPerWindow < 0) {
    throw new TypeError('maxPerWindow must be an integer >= 0');
  }
  if (!(request.windowHours > 0)) throw new TypeError('windowHours must be > 0');
  if (!(request.minGapMinutes >= 0)) throw new TypeError('minGapMinutes must be >= 0');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
}

async function breakIfStale(lockDir) {
  let info;
  try {
    info = await stat(lockDir);
  } catch {
    return; // already gone
  }
  if (Date.now() - info.mtimeMs < LOCK_STALE_MS) return;
  // rename is atomic: only one worker can move the stale lock away.
  const graveyard = `${lockDir}.stale-${randomUUID()}`;
  try {
    await rename(lockDir, graveyard);
    await rm(graveyard, { recursive: true, force: true });
  } catch {
    // another worker broke it first
  }
}

async function withLock(lockDir, fn) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      await breakIfStale(lockDir);
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${lockDir}`);
      await sleep(5 + Math.random() * 20);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function loadRecord(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { keepMs: 0, reservations: [] };
    throw err;
  }
}

async function saveRecord(file, record) {
  // temp file then rename: a reader or a restarted worker never sees half a file.
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(record));
  await rename(tmp, file);
}

// Claims a send slot for one lead. Only held (not released) reservations count.
// Window: sliding, so any span of windowHours holds at most maxPerWindow sends.
// Gap: at least minGapMinutes after the most recent held reservation.
export async function reserve(request, now) {
  validate(request, now);
  const at = now.getTime();
  const windowMs = request.windowHours * HOUR;
  const gapMs = request.minGapMinutes * MINUTE;
  const key = createHash('sha256').update(request.userId).digest('hex');
  await mkdir(leadsDir(), { recursive: true });
  const { file, lock } = leadPaths(key);

  return withLock(lock, async () => {
    const record = await loadRecord(file);
    // Keep entries as long as the largest window ever asked for this lead.
    record.keepMs = Math.max(record.keepMs ?? 0, windowMs);
    record.reservations = record.reservations.filter((r) => at - r.at < record.keepMs);

    const held = record.reservations.filter((r) => r.status === 'held');
    const inWindow = held.filter((r) => r.at > at - windowMs);
    if (inWindow.length >= request.maxPerWindow) {
      return { allowed: false, reason: 'window_limit_reached', reservationId: null };
    }
    if (gapMs > 0 && held.length > 0) {
      const last = Math.max(...held.map((r) => r.at));
      if (at - last < gapMs) {
        return { allowed: false, reason: 'min_gap_not_elapsed', reservationId: null };
      }
    }

    const id = randomUUID();
    record.reservations.push({ id, at, status: 'held' });
    await saveRecord(file, record);
    return { allowed: true, reason: null, reservationId: `${key}:${id}` };
  });
}

// Gives a slot back after the provider rejected the message. Returns true if a
// held slot was released, false for an unknown, malformed or already-released id.
export async function release(reservationId) {
  const [key, id, extra] = String(reservationId ?? '').split(':');
  if (!/^[0-9a-f]{64}$/.test(key ?? '') || !id || extra !== undefined) return false;
  const { file, lock } = leadPaths(key);
  try {
    await stat(file);
  } catch {
    return false;
  }

  return withLock(lock, async () => {
    const record = await loadRecord(file);
    const entry = record.reservations.find((r) => r.id === id);
    if (!entry || entry.status !== 'held') return false;
    entry.status = 'released';
    await saveRecord(file, record);
    return true;
  });
}
