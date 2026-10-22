// Shared outbound send limiter for follow-up messages.
// State lives in STATE_DIR so every worker process and every restart sees the same history.
//
// What counts as a send: a slot that was reserved and not released. A refused
// request spends nothing, so retries do not push the window further out.
// Window: sliding. A send stops counting once it is windowHours old.
// Gap: minGapMinutes is measured from the most recent counted send to this lead.
// Limits are per lead (userId), across channels, because the lead experiences both
// WhatsApp and SMS as messages from us.

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 10;
// Entries older than this are dropped. Must be longer than any windowHours in use.
const KEEP_MS = 366 * 24 * 3600 * 1000;
const RESERVATION_ID = /^[A-Za-z0-9_-]+\.[0-9a-f-]{36}$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Read STATE_DIR on every call, not at import time.
function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

// Cross-process lock: mkdir is atomic, so only one process holds the directory at a time.
async function withLock(dir, fn) {
  await mkdir(dir, { recursive: true });
  const lock = path.join(dir, '.lock');
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const info = await stat(lock);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          // Holder crashed while locked. Remove the stale lock and retry.
          await rm(lock, { recursive: true, force: true });
          continue;
        }
      } catch (statErr) {
        if (statErr.code !== 'ENOENT') throw statErr;
        continue;
      }
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

// File name is base64url(userId), so any userId is safe as a file name.
const leadKey = (userId) => Buffer.from(userId, 'utf8').toString('base64url');
const leadFile = (dir, key) => path.join(dir, 'leads', `${key}.json`);

async function readLead(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { sends: [] };
    throw err;
  }
}

// Temp file then rename: a reader never sees a half-written record.
async function writeLead(file, data) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
}

export async function reserve(request, now) {
  const { userId, maxPerWindow, windowHours, minGapMinutes } = request ?? {};
  if (typeof userId !== 'string' || userId === '') throw new Error('userId must be a non-empty string');
  if (!Number.isInteger(maxPerWindow) || maxPerWindow < 1) throw new Error('maxPerWindow must be a positive integer');
  if (!(windowHours > 0)) throw new Error('windowHours must be > 0');
  if (!(minGapMinutes >= 0)) throw new Error('minGapMinutes must be >= 0');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('now must be a valid Date');

  const t = now.getTime();
  const windowMs = windowHours * 3600 * 1000;
  const gapMs = minGapMinutes * 60 * 1000;
  const dir = stateDir();
  const key = leadKey(userId);
  const file = leadFile(dir, key);

  return withLock(dir, async () => {
    await mkdir(path.join(dir, 'leads'), { recursive: true });
    const lead = await readLead(file);
    lead.sends = lead.sends.filter((s) => s.at > t - KEEP_MS);

    // Entries after this caller's clock are still counted, so skew between workers stays conservative.
    const inWindow = lead.sends.filter((s) => s.at > t - windowMs);
    if (inWindow.length >= maxPerWindow) {
      await writeLead(file, lead);
      return { allowed: false, reason: 'max_per_window_reached', reservationId: null };
    }

    if (gapMs > 0 && lead.sends.length > 0) {
      const last = Math.max(...lead.sends.map((s) => s.at));
      if (t - last < gapMs) {
        await writeLead(file, lead);
        return { allowed: false, reason: 'min_gap_not_elapsed', reservationId: null };
      }
    }

    const reservationId = `${key}.${randomUUID()}`;
    lead.sends.push({ id: reservationId, at: t });
    await writeLead(file, lead);
    return { allowed: true, reason: null, reservationId };
  });
}

// Returns true when a slot was given back, false when the id is unknown or already released.
export async function release(reservationId) {
  if (typeof reservationId !== 'string' || !RESERVATION_ID.test(reservationId)) return false;
  const dir = stateDir();
  const key = reservationId.slice(0, reservationId.indexOf('.'));
  const file = leadFile(dir, key);

  return withLock(dir, async () => {
    const lead = await readLead(file);
    const before = lead.sends.length;
    lead.sends = lead.sends.filter((s) => s.id !== reservationId);
    if (lead.sends.length === before) return false;
    await writeLead(file, lead);
    return true;
  });
}
