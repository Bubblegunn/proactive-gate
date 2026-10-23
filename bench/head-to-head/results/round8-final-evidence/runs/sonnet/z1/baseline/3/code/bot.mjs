// Gate for proactive notifications (daily check-in and other types).
// Rules, in order. Any failing rule means "do not send":
//   1. flags.proactiveEnabled must be true (emergency kill switch).
//   2. Input must be valid (user id, candidate id/type, valid `now`).
//   3. User must not have opted out of this type.
//   4. User must have explicitly consented (consents.marketing === true).
//      Missing/empty consents count as "no consent".
//   5. The user's local time must be known and inside the allowed window.
//      Zone priority: deviceTimezone, then timezone. "UTC" is a placeholder
//      and is not trusted; if no real zone is known we do not send.
//   6. Frequency: one per type per local day, minimum gap between sends,
//      a rolling 24h cap over all types, and the same candidate is never
//      delivered twice.
//   7. Dismissal back-off: each consecutive dismissal of a type doubles the
//      quiet period (2, 4, 8, 16, then 30 days).
// State is one JSON file per user in STATE_DIR, guarded by a lock directory so
// several worker processes can share it. Writes are atomic (temp file + rename).
// If state cannot be read or locked, we fail closed (no send).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const WINDOW_START_HOUR = 9; // inclusive, local time
const WINDOW_END_HOUR = 20; // exclusive, local time (last send 19:59)
const MIN_GAP_SAME_TYPE_MS = 20 * HOUR;
const MIN_GAP_ANY_MS = 2 * HOUR;
const MAX_PER_ROLLING_DAY = 3;
const BACKOFF_BASE_DAYS = 2;
const BACKOFF_MAX_DAYS = 30;
const DISMISSAL_FORGET_MS = 90 * DAY; // streak resets if last dismissal is older
const KEEP_SENDS_MS = 2 * DAY;

const LOCK_STALE_MS = 10 * 1000;
const LOCK_WAIT_MS = 8 * 1000;

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
  const key = userKey(userId);
  const lockPath = path.join(dir, `${key}.lock`);
  const statePath = path.join(dir, `${key}.json`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await fs.mkdir(lockPath);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fs.rmdir(lockPath).catch(() => {});
          continue;
        }
      } catch {
        continue; // lock vanished, retry
      }
      if (Date.now() > deadline) throw new Error('lock timeout');
      await sleep(5 + Math.random() * 20);
    }
  }
  try {
    return await fn(statePath);
  } finally {
    await fs.rmdir(lockPath).catch(() => {});
  }
}

function emptyState() {
  return { optOut: {}, dismissals: {}, sends: [] };
}

async function readState(statePath) {
  let text;
  try {
    text = await fs.readFile(statePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return emptyState();
    throw e;
  }
  const s = JSON.parse(text); // corrupt state throws -> fail closed
  return {
    optOut: s.optOut && typeof s.optOut === 'object' ? s.optOut : {},
    dismissals: s.dismissals && typeof s.dismissals === 'object' ? s.dismissals : {},
    sends: Array.isArray(s.sends) ? s.sends : [],
  };
}

async function writeState(statePath, state) {
  const tmp = `${statePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(state));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, statePath);
}

function validZone(z) {
  if (typeof z !== 'string' || !z.trim()) return null;
  const zone = z.trim();
  if (zone.toUpperCase() === 'UTC' || zone.toUpperCase() === 'ETC/UTC' || zone === 'GMT' || zone === 'Z') {
    return null; // placeholder, not a real location
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

function localParts(date, zone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const p = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

function toDate(now) {
  const d = now instanceof Date ? now : new Date(now);
  return Number.isFinite(d.getTime()) ? d : null;
}

const no = (reason) => ({ send: false, reason });

export async function decide({ user, candidate, now, flags } = {}) {
  if (!flags || flags.proactiveEnabled !== true) {
    return no('Proactive notifications are switched off right now.');
  }
  const when = toDate(now);
  if (!when) return no('The current time is not valid.');
  if (!user || user.id == null || user.id === '') return no('The user is unknown.');
  if (!candidate || candidate.id == null || typeof candidate.type !== 'string' || !candidate.type) {
    return no('The notification is not valid.');
  }
  const type = candidate.type;
  const t = when.getTime();

  const consents = user.consents;
  if (!consents || typeof consents !== 'object' || consents.marketing !== true) {
    return no('The user has not agreed to receive these notifications.');
  }

  const zone = validZone(user.deviceTimezone) || validZone(user.timezone);
  if (!zone) return no("The user's local time is unknown, so quiet hours cannot be checked.");
  const local = localParts(when, zone);
  if (local.hour < WINDOW_START_HOUR || local.hour >= WINDOW_END_HOUR) {
    return no("It is outside the user's allowed hours (09:00 to 20:00 local time).");
  }

  try {
    return await withUserLock(user.id, async (statePath) => {
      const state = await readState(statePath);

      if (state.optOut[type]) return no('The user turned this notification type off.');

      const dis = state.dismissals[type];
      if (dis && t - dis.last <= DISMISSAL_FORGET_MS) {
        const days = Math.min(BACKOFF_MAX_DAYS, BACKOFF_BASE_DAYS ** Math.max(1, dis.count));
        if (t < dis.last + days * DAY) {
          return no('The user recently dismissed this notification type, so we are waiting longer.');
        }
      }

      const sends = state.sends.filter((s) => t - s.at < KEEP_SENDS_MS || s.at > t);
      const idStr = String(candidate.id);
      if (sends.some((s) => s.id === idStr && s.type === type)) {
        return no('This notification was already delivered.');
      }
      // Entries in the future (clock skew) still count as recent.
      const recent = sends.filter((s) => Math.abs(t - s.at) < DAY);
      if (recent.length >= MAX_PER_ROLLING_DAY) {
        return no('The user already received enough notifications in the last 24 hours.');
      }
      if (sends.some((s) => Math.abs(t - s.at) < MIN_GAP_ANY_MS)) {
        return no('Another notification was delivered very recently.');
      }
      if (sends.some((s) => s.type === type && (s.day === local.day || Math.abs(t - s.at) < MIN_GAP_SAME_TYPE_MS))) {
        return no('This notification type was already delivered today.');
      }

      sends.push({ id: idStr, type, at: t, day: local.day });
      state.sends = sends;
      await writeState(statePath, state);
      return { send: true, reason: null };
    });
  } catch {
    return no('Notification state could not be read safely, so nothing was sent.');
  }
}

export async function recordDismissal(userId, type, now) {
  const when = toDate(now ?? new Date()) ?? new Date();
  const t = when.getTime();
  await withUserLock(userId, async (statePath) => {
    const state = await readState(statePath);
    const prev = state.dismissals[type];
    const count = prev && t - prev.last <= DISMISSAL_FORGET_MS ? prev.count + 1 : 1;
    state.dismissals[type] = { count, last: Math.max(t, prev?.last ?? 0) };
    await writeState(statePath, state);
  });
}

export async function optOut(userId, type) {
  await withUserLock(userId, async (statePath) => {
    const state = await readState(statePath);
    state.optOut[type] = true;
    await writeState(statePath, state);
  });
}
