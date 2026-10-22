// Shared send-rate limiter for proactive lead follow-ups.
//
// State lives in STATE_DIR so every worker process on the machine sees the same
// history and it survives restarts:
//   STATE_DIR/leads/<sha256(userId)>.json   per-lead reservation history
//   STATE_DIR/locks/<sha256(userId)>.lock/  mkdir-based mutex, one per lead
//
// Counting rules (what the recipient experiences):
// - A reservation counts from the moment it is allowed, not when the provider
//   acknowledges it. A worker may crash mid-send, so an in-flight send is treated
//   as sent.
// - A reservation that was released (provider rejected it, lead got nothing)
//   stops counting.
// - Blocked attempts never count. Otherwise a retrying worker would lock itself
//   out for as long as it kept retrying.
// - The window is sliding: a send counts for exactly windowHours after it was
//   reserved, not until the next calendar day.
// - The gap is measured from the most recent counted send. A send is blocked
//   while less than minGapMinutes has passed since it. A send timestamped after
//   `now` (another worker with a slightly ahead clock) also blocks, which is the
//   conservative choice.

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
// A lock older than this is assumed to belong to a crashed worker. The critical
// section takes milliseconds, so a live holder never gets near this.
const LOCK_STALE_MS = 5000;

const REASON_MAX_PER_WINDOW = 'max_per_window';
const REASON_MIN_GAP = 'min_gap';

function requireStateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR environment variable is not set');
  return dir;
}

function validateRequest(request, now) {
  if (!request || typeof request !== 'object') {
    throw new TypeError('request must be an object');
  }
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request;
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new TypeError('userId must be a non-empty string');
  }
  if (!Number.isInteger(maxPerWindow) || maxPerWindow < 0) {
    throw new RangeError('maxPerWindow must be a non-negative integer');
  }
  if (typeof windowHours !== 'number' || !(windowHours > 0) || !Number.isFinite(windowHours)) {
    throw new RangeError('windowHours must be a positive finite number');
  }
  if (typeof minGapMinutes !== 'number' || !(minGapMinutes >= 0) || !Number.isFinite(minGapMinutes)) {
    throw new RangeError('minGapMinutes must be a non-negative finite number');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('now must be a valid Date');
  }
  return { userId, maxPerWindow, windowHours, minGapMinutes };
}

function leadKey(userId) {
  return createHash('sha256').update(userId).digest('hex');
}

async function ensureDirs(dir) {
  await fs.mkdir(path.join(dir, 'leads'), { recursive: true });
  await fs.mkdir(path.join(dir, 'locks'), { recursive: true });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs fn while holding the lead's lock. mkdir is atomic on the local
// filesystem, so exactly one process can create the lock directory at a time.
async function withLeadLock(dir, key, fn) {
  const lockPath = path.join(dir, 'locks', `${key}.lock`);
  for (;;) {
    try {
      await fs.mkdir(lockPath);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    try {
      const stat = await fs.stat(lockPath);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await fs.rm(lockPath, { recursive: true, force: true });
        continue;
      }
    } catch (err) {
      // The holder released between our mkdir and stat. Try again right away.
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    await sleep(2 + Math.random() * 8);
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}

async function readLead(file, userId) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { userId, horizonMs: 0, reservations: [] };
    throw err;
  }
}

// Write to a temp file, fsync, then rename. A reader or a restarted worker sees
// either the old history or the new one, never a half-written file.
async function writeLead(file, lead) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify(lead));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
}

// Drops history that no future window can reach. The horizon is the largest
// windowHours seen for this lead. The newest active reservation is always kept
// so the min-gap check still has its reference point.
function prune(lead, nowMs) {
  const cutoff = nowMs - lead.horizonMs;
  let newestActive = null;
  for (const r of lead.reservations) {
    if (!r.released && (newestActive === null || r.at > newestActive.at)) newestActive = r;
  }
  lead.reservations = lead.reservations.filter(
    (r) => r.at > cutoff || r === newestActive,
  );
}

export async function reserve(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = validateRequest(request, now);
  const dir = requireStateDir();
  const key = leadKey(userId);
  await ensureDirs(dir);

  return withLeadLock(dir, key, async () => {
    const file = path.join(dir, 'leads', `${key}.json`);
    const lead = await readLead(file, userId);
    const nowMs = now.getTime();
    const windowMs = windowHours * HOUR_MS;
    const gapMs = minGapMinutes * MINUTE_MS;

    const active = lead.reservations.filter((r) => !r.released);

    const sentInWindow = active.filter((r) => r.at > nowMs - windowMs).length;
    if (sentInWindow >= maxPerWindow) {
      return { allowed: false, reason: REASON_MAX_PER_WINDOW, reservationId: null };
    }

    if (gapMs > 0 && active.length > 0) {
      const latestMs = active.reduce((max, r) => Math.max(max, r.at), -Infinity);
      if (nowMs - latestMs < gapMs) {
        return { allowed: false, reason: REASON_MIN_GAP, reservationId: null };
      }
    }

    const reservationId = `${key}.${randomUUID()}`;
    lead.reservations.push({ id: reservationId, at: nowMs, released: false });
    lead.horizonMs = Math.max(lead.horizonMs, windowMs);
    prune(lead, nowMs);
    await writeLead(file, lead);
    return { allowed: true, reason: null, reservationId };
  });
}

// Returns true if a live reservation was released, false otherwise (unknown id,
// already released, or malformed id). Safe to call from any worker process.
export async function release(reservationId) {
  if (typeof reservationId !== 'string') return false;
  const dot = reservationId.indexOf('.');
  const key = dot === -1 ? '' : reservationId.slice(0, dot);
  if (!/^[0-9a-f]{64}$/.test(key)) return false;

  const dir = requireStateDir();
  await ensureDirs(dir);

  return withLeadLock(dir, key, async () => {
    const file = path.join(dir, 'leads', `${key}.json`);
    let lead;
    try {
      lead = await readLead(file, null);
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
    const entry = lead.reservations.find((r) => r.id === reservationId);
    if (!entry || entry.released) return false;
    entry.released = true;
    await writeLead(file, lead);
    return true;
  });
}
