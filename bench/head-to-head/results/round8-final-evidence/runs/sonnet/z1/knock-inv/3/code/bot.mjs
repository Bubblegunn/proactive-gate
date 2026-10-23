import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_START_HOUR = 9; // local time, inclusive
const WINDOW_END_HOUR = 20; // local time, exclusive
const NEW_USER_GRACE_MS = DAY_MS; // no proactive message in the first 24 hours
const MAX_PER_TYPE_PER_DAY = 1;
const MAX_PROACTIVE_PER_DAY = 2; // all types together, per user local day
const MAX_BACKOFF_DAYS = 30;
const DISMISSAL_DECAY_MS = 60 * DAY_MS;
const SENT_RETENTION_MS = 7 * DAY_MS;
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 8_000;

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function userFile(dir, userId) {
  const key = createHash('sha256').update(String(userId)).digest('hex');
  return path.join(dir, `user-${key}.json`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cross-process lock: mkdir is atomic. A lock older than LOCK_STALE_MS is treated as abandoned.
async function withLock(userId, fn) {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const file = userFile(dir, userId);
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const st = await stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await rmdir(lock).catch(() => {});
          continue;
        }
      } catch {
        continue; // lock vanished, retry
      }
      if (Date.now() > deadline) throw new Error('could not get state lock');
      await sleep(5 + Math.random() * 20);
    }
  }
  try {
    let state = { optOut: {}, dismissals: {}, sent: [] };
    try {
      state = { ...state, ...JSON.parse(await readFile(file, 'utf8')) };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const result = await fn(state);
    if (result.dirty) {
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, JSON.stringify(state));
      await rename(tmp, file);
    }
    return result.value;
  } finally {
    await rmdir(lock).catch(() => {});
  }
}

function validZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const isPlaceholder = (tz) => /^(utc|gmt|etc\/utc|etc\/gmt|z)$/i.test(tz.trim());

// The phone's last reported zone is the best guess of where the user is now.
// The signup zone is the fallback. "UTC" is a placeholder, not a real location.
function resolveZone(user) {
  for (const tz of [user.deviceTimezone, user.timezone]) {
    if (validZone(tz) && !isPlaceholder(tz)) return tz;
  }
  return null;
}

function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

const no = (reason) => ({ send: false, reason });

export async function decide({ user, candidate, now, flags } = {}) {
  try {
    if (!user || !user.id || !candidate || !candidate.id || !candidate.type) {
      return no('Missing user or notification data.');
    }
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return no('The current time is invalid.');
    if (!flags || flags.proactiveEnabled !== true) return no('Proactive notifications are switched off.');

    // Explicit, recorded consent is required. Missing or empty consents mean no consent.
    if (!user.consents || user.consents.marketing !== true) {
      return no('The user has not agreed to receive these notifications.');
    }

    const zone = resolveZone(user);
    if (!zone) return no('The user time zone is unknown, so local quiet hours cannot be checked.');

    const created = Date.parse(user.createdAt);
    if (!Number.isNaN(created) && now.getTime() - created < NEW_USER_GRACE_MS) {
      return no('The account is less than a day old.');
    }

    const local = localParts(now, zone);
    if (local.hour < WINDOW_START_HOUR || local.hour >= WINDOW_END_HOUR) {
      return no(`It is outside the allowed hours (${WINDOW_START_HOUR}:00-${WINDOW_END_HOUR}:00) for the user.`);
    }

    const type = candidate.type;
    return await withLock(user.id, async (state) => {
      const t = now.getTime();
      const out = (value, dirty = false) => ({ value, dirty });

      if (state.optOut[type]) return out(no('The user turned this notification off.'));
      if (state.sent.some((s) => s.id === candidate.id)) {
        return out(no('This notification was already delivered.'));
      }

      const d = state.dismissals[type];
      if (d && t - d.last < DISMISSAL_DECAY_MS) {
        const waitDays = Math.min(2 ** d.count, MAX_BACKOFF_DAYS);
        if (t - d.last < waitDays * DAY_MS) {
          return out(no('The user recently dismissed this notification, so we wait before showing it again.'));
        }
      }

      const today = state.sent.filter((s) => localParts(new Date(s.ts), zone).day === local.day);
      if (today.filter((s) => s.type === type).length >= MAX_PER_TYPE_PER_DAY) {
        return out(no('This notification was already delivered today.'));
      }
      if (today.length >= MAX_PROACTIVE_PER_DAY) {
        return out(no('The daily limit of notifications has been reached.'));
      }

      state.sent = state.sent.filter((s) => t - s.ts < SENT_RETENTION_MS);
      state.sent.push({ id: candidate.id, type, ts: t });
      return out({ send: true, reason: null }, true);
    });
  } catch (err) {
    // Fail closed: an unreadable state must never cause an unwanted notification.
    return no(`Not sent because of an internal error: ${err.message}`);
  }
}

export async function recordDismissal(userId, type, now = new Date()) {
  const t = now instanceof Date ? now.getTime() : Date.now();
  await withLock(userId, async (state) => {
    const d = state.dismissals[type];
    const count = d && t - d.last < DISMISSAL_DECAY_MS ? d.count + 1 : 1;
    state.dismissals[type] = { count, last: t };
    return { value: undefined, dirty: true };
  });
}

export async function optOut(userId, type) {
  await withLock(userId, async (state) => {
    state.optOut[type] = true;
    return { value: undefined, dirty: true };
  });
}
