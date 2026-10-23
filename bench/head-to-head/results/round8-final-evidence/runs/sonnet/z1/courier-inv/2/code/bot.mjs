// Gate for proactive notifications (daily check-in and other types).
// Rules, all fail-closed:
//  - emergency flag off -> never send
//  - no explicit marketing consent -> never send
//  - user opted the type out -> never send
//  - recent dismissals -> pause that type, longer each time
//  - only 09:00-19:59 in the user's local time; unknown local time -> do not send
//  - one per type per local day, at most 2 proactive notifications per local day
//  - the same candidate id is never delivered twice
// State: one JSON file per user in STATE_DIR, guarded by a lock directory so
// several worker processes on one machine can check-and-record atomically.

import { promises as fs } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

const WINDOW_START_HOUR = 9;
const WINDOW_END_HOUR = 20; // exclusive
const MAX_PER_DAY_ALL_TYPES = 2;
const MAX_PER_DAY_PER_TYPE = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const DISMISSAL_RESET_MS = 90 * DAY_MS;
const SENT_HISTORY_MS = 30 * DAY_MS;
const LOCK_STALE_MS = 15000;
const LOCK_TIMEOUT_MS = 20000;

function pauseDaysForDismissals(count) {
  if (count <= 1) return 3;
  if (count === 2) return 7;
  return 30;
}

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function userKey(userId) {
  return createHash('sha256').update(String(userId)).digest('hex');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withUserLock(userId, fn) {
  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const lock = path.join(dir, `${userKey(userId)}.lock`);
  const started = Date.now();
  for (;;) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          // Break a stale lock by renaming it away first; only one process wins the rename.
          const grave = `${lock}.stale-${randomBytes(6).toString('hex')}`;
          try {
            await fs.rename(lock, grave);
            await fs.rm(grave, { recursive: true, force: true });
          } catch {}
          continue;
        }
      } catch {}
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error('timed out waiting for user lock');
      await sleep(5 + Math.random() * 20);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

function emptyState() {
  return { optedOut: {}, dismissals: {}, sent: [] };
}

async function readState(userId) {
  const file = path.join(stateDir(), `${userKey(userId)}.json`);
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return emptyState();
    throw e;
  }
  const s = JSON.parse(text); // corrupt state throws; callers fail closed
  return {
    optedOut: s.optedOut && typeof s.optedOut === 'object' ? s.optedOut : {},
    dismissals: s.dismissals && typeof s.dismissals === 'object' ? s.dismissals : {},
    sent: Array.isArray(s.sent) ? s.sent : [],
  };
}

async function writeState(userId, state) {
  const dir = stateDir();
  const file = path.join(dir, `${userKey(userId)}.json`);
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify(state));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
}

function validZone(z) {
  if (typeof z !== 'string' || !z.trim()) return null;
  const zone = z.trim();
  if (zone.toUpperCase() === 'UTC' || zone.toUpperCase() === 'GMT' || zone === 'Etc/UTC') return null; // placeholder, not a real location
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

// Device zone is the most recent; the signup zone is the fallback.
function resolveZone(user) {
  return validZone(user.deviceTimezone) ?? validZone(user.timezone);
}

function localParts(date, zone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

function validDate(d) {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

const no = (reason) => ({ send: false, reason });

export async function decide({ user, candidate, now, flags } = {}) {
  try {
    if (!flags || flags.proactiveEnabled !== true) return no('Proactive notifications are switched off right now.');
    if (!user || user.id == null || !candidate || !candidate.type || candidate.id == null) {
      return no('The request is missing user or notification details.');
    }
    if (!validDate(now)) return no('The current time is not valid.');
    if (!user.consents || user.consents.marketing !== true) {
      return no('The user has not given consent for these notifications.');
    }
    const zone = resolveZone(user);
    if (!zone) return no('The user\'s local time is unknown.');
    const local = localParts(now, zone);
    if (local.hour < WINDOW_START_HOUR || local.hour >= WINDOW_END_HOUR) {
      return no('It is outside the user\'s daytime hours.');
    }

    const type = String(candidate.type);
    const candidateId = String(candidate.id);

    return await withUserLock(user.id, async () => {
      const state = await readState(user.id);

      if (state.optedOut[type]) return no('The user turned this notification type off.');

      const dismissal = state.dismissals[type];
      if (dismissal) {
        const until = dismissal.last + pauseDaysForDismissals(dismissal.count) * DAY_MS;
        if (now.getTime() < until) return no('The user recently dismissed this notification type.');
      }

      if (state.sent.some((s) => s.type === type && s.id === candidateId)) {
        return no('This notification was already delivered.');
      }

      const today = state.sent.filter((s) => s.day === local.day);
      if (today.filter((s) => s.type === type).length >= MAX_PER_DAY_PER_TYPE) {
        return no('This type was already delivered today.');
      }
      if (today.length >= MAX_PER_DAY_ALL_TYPES) {
        return no('The daily limit of notifications was reached.');
      }

      const cutoff = now.getTime() - SENT_HISTORY_MS;
      state.sent = state.sent.filter((s) => s.at >= cutoff);
      state.sent.push({ type, id: candidateId, at: now.getTime(), day: local.day });
      await writeState(user.id, state);
      return { send: true, reason: null };
    });
  } catch {
    return no('The notification state could not be checked safely.');
  }
}

export async function recordDismissal(userId, type, now) {
  const at = validDate(now) ? now.getTime() : Date.now();
  await withUserLock(userId, async () => {
    const state = await readState(userId);
    const prev = state.dismissals[type];
    const count = prev && at - prev.last < DISMISSAL_RESET_MS ? prev.count + 1 : 1;
    state.dismissals[type] = { count, last: Math.max(at, prev ? prev.last : 0) };
    await writeState(userId, state);
  });
}

export async function optOut(userId, type) {
  await withUserLock(userId, async () => {
    const state = await readState(userId);
    state.optedOut[type] = true;
    await writeState(userId, state);
  });
}
