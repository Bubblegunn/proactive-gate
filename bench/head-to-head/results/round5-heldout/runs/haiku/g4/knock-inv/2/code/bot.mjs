// Shared per-lead send rate limiter.
//
// Every worker on the machine calls reserve() before sending and release()
// if the provider rejects the message. State lives in STATE_DIR so that all
// workers see the same history and it survives restarts.
//
// Layout under STATE_DIR:
//   leads/<sha256(userId)>.json   reservation history for one lead
//   locks/<sha256(userId)>.lock/  mkdir-based lock held during read-modify-write
//
// Counting rules (what the recipient experiences):
//   - A send counts from the moment its slot is reserved, not when the provider
//     accepts it. If a worker crashes between reserve and send, the slot is
//     still used up. That over-counts, which is the safe direction.
//   - A released slot (provider rejected the message) stops counting for both
//     limits, because the lead never received it.
//   - The window is rolling: "at most maxPerWindow messages in any windowHours
//     span", not a calendar day. Recipients feel bursts, not day boundaries.
//   - The gap is measured from the most recent counted send, so the minimum
//     spacing between any two messages to the lead is minGapMinutes.
//   - Timestamps in the future (clock skew between callers) count as in-window
//     and make the gap check fail. Both errors make the limiter stricter, not looser.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 15_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

export const REASON_WINDOW_LIMIT = 'window_limit_reached';
export const REASON_MIN_GAP = 'min_gap_not_elapsed';

export async function reserve(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = validateRequest(request, now);
  const root = stateDirOrThrow();
  await ensureDirs(root);

  const key = keyFor(userId);
  const file = leadFile(root, key);
  const windowMs = windowHours * HOUR_MS;
  const gapMs = minGapMinutes * MINUTE_MS;
  const nowMs = now.getTime();

  return withLead(root, key, async () => {
    const lead = await loadLead(file);
    // Keep records long enough for the largest window or gap any caller has used.
    lead.keepMs = Math.max(lead.keepMs, windowMs, gapMs);
    lead.reservations = lead.reservations.filter((r) => r.at > nowMs - lead.keepMs);

    const held = lead.reservations.filter((r) => r.status === 'held');

    const inWindow = held.filter((r) => r.at > nowMs - windowMs).length;
    if (inWindow >= maxPerWindow) {
      await saveLead(file, lead);
      return { allowed: false, reason: REASON_WINDOW_LIMIT, reservationId: null };
    }

    if (held.length > 0) {
      const latest = Math.max(...held.map((r) => r.at));
      if (nowMs - latest < gapMs) {
        await saveLead(file, lead);
        return { allowed: false, reason: REASON_MIN_GAP, reservationId: null };
      }
    }

    const id = randomUUID();
    lead.reservations.push({ id, at: nowMs, status: 'held' });
    await saveLead(file, lead);
    return { allowed: true, reason: null, reservationId: `${key}:${id}` };
  });
}

export async function release(reservationId) {
  // Callers may pass the null reservationId from a denied reserve(); nothing to give back.
  if (reservationId == null) return;

  const [key, id, ...extra] = String(reservationId).split(':');
  if (extra.length > 0 || !/^[0-9a-f]{64}$/.test(key) || !id) {
    throw new TypeError('release: malformed reservationId');
  }

  const root = stateDirOrThrow();
  await ensureDirs(root);
  const file = leadFile(root, key);

  await withLead(root, key, async () => {
    const lead = await loadLead(file);
    const target = lead.reservations.find((r) => r.id === id && r.status === 'held');
    // Unknown, already released, or pruned: no-op, so a retried release is safe.
    if (!target) return;
    target.status = 'released';
    await saveLead(file, lead);
  });
}

// ---------------------------------------------------------------------------

function stateDirOrThrow() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR environment variable is not set');
  return dir;
}

async function ensureDirs(root) {
  await mkdir(path.join(root, 'leads'), { recursive: true });
  await mkdir(path.join(root, 'locks'), { recursive: true });
}

function keyFor(userId) {
  return createHash('sha256').update(userId).digest('hex');
}

function leadFile(root, key) {
  return path.join(root, 'leads', `${key}.json`);
}

function validateRequest(request, now) {
  if (request == null || typeof request !== 'object') {
    throw new TypeError('reserve: request must be an object');
  }
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request;
  if (typeof userId !== 'string' || userId === '') {
    throw new TypeError('reserve: userId must be a non-empty string');
  }
  if (!Number.isInteger(maxPerWindow) || maxPerWindow < 0) {
    throw new TypeError('reserve: maxPerWindow must be a non-negative integer');
  }
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    throw new TypeError('reserve: windowHours must be a positive number');
  }
  if (!Number.isFinite(minGapMinutes) || minGapMinutes < 0) {
    throw new TypeError('reserve: minGapMinutes must be a non-negative number');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('reserve: now must be a valid Date');
  }
  return { userId, maxPerWindow, windowHours, minGapMinutes };
}

// Serialises read-modify-write for one lead across processes. mkdir is atomic,
// so only one process holds the lock at a time. A lock older than
// LOCK_STALE_MS is treated as left behind by a crashed worker.
async function withLead(root, key, fn) {
  const lockDir = path.join(root, 'locks', `${key}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      await mkdir(lockDir);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch (statErr) {
        if (statErr.code !== 'ENOENT') throw statErr;
        continue; // holder just released it; retry immediately
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for limiter lock ${key}`);
      }
      await sleep(5 + Math.random() * 20);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function loadLead(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { keepMs: 0, reservations: [] };
    throw err;
  }
  // A corrupt file throws instead of resetting: resetting would silently erase
  // history and let the limiter over-send.
  return JSON.parse(raw);
}

async function saveLead(file, lead) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(lead));
  await rename(tmp, file); // atomic replace, so readers never see a partial file
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
