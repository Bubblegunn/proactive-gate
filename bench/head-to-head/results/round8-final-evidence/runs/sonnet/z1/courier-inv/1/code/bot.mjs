// Gate for proactive notifications (daily check-in and other types).
// No dependencies. State lives in STATE_DIR, one JSON file per user, guarded by a
// per-user lock directory so several worker processes can share it.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';

const HOUR = 3600e3;
const DAY = 24 * HOUR;

const WINDOW_START_HOUR = 9; // local time, inclusive
const WINDOW_END_HOUR = 20; // local time, exclusive
const MIN_GAP_SAME_TYPE = 20 * HOUR;
const MIN_GAP_ANY_TYPE = 3 * HOUR;
const MAX_PER_LOCAL_DAY = 2;
const NEW_USER_GRACE = 24 * HOUR;
const DISMISS_PAUSE_DAYS = [3, 7, 14, 30]; // pause after the 1st, 2nd, 3rd, 4th+ dismissal
const DISMISS_FORGET = 90 * DAY; // dismissal history older than this is ignored
const PLACEHOLDER_ZONES = new Set(['utc', 'etc/utc', 'gmt', 'etc/gmt', 'z', 'zulu']);

const LOCK_STALE_MS = 10e3;
const LOCK_WAIT_MS = 15e3;

// ---------- storage ----------

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function userPath(userId, ext) {
  const h = createHash('sha256').update(String(userId)).digest('hex');
  return path.join(stateDir(), `u-${h}.${ext}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withLock(userId, fn) {
  await mkdir(stateDir(), { recursive: true });
  const lock = userPath(userId, 'lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          // Lock holder died. Move the stale lock aside (atomic), then retry.
          const aside = `${lock}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
          await rename(lock, aside).catch(() => {});
          await rmdir(aside).catch(() => {});
          continue;
        }
      } catch {
        continue; // lock vanished
      }
      if (Date.now() > deadline) throw new Error('could not lock user state');
      await sleep(5 + Math.random() * 20);
    }
  }
  try {
    return await fn();
  } finally {
    await rmdir(lock).catch(() => {});
  }
}

async function load(userId) {
  try {
    const s = JSON.parse(await readFile(userPath(userId, 'json'), 'utf8'));
    if (s && typeof s === 'object') return normalize(s);
  } catch (e) {
    if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
  }
  return normalize({});
}

function normalize(s) {
  return {
    optedOut: s.optedOut && typeof s.optedOut === 'object' ? s.optedOut : {},
    dismissals: s.dismissals && typeof s.dismissals === 'object' ? s.dismissals : {},
    sent: Array.isArray(s.sent) ? s.sent : [], // [{ t: type, at: ms, day: 'YYYY-MM-DD' }]
  };
}

async function save(userId, state) {
  const file = userPath(userId, 'json');
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, file);
}

// Keys come from callers; prefix them so "__proto__" and similar are plain keys.
const key = (type) => `t:${type}`;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---------- time zone ----------

function validZone(z) {
  if (typeof z !== 'string' || !z.trim()) return null;
  const name = z.trim();
  if (PLACEHOLDER_ZONES.has(name.toLowerCase())) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return name;
  } catch {
    return null;
  }
}

// The phone's last reported zone is the most current. The signup zone is the fallback.
// "UTC" is a placeholder, not a real location, so it counts as unknown.
function pickZone(user) {
  return validZone(user.deviceTimezone) || validZone(user.timezone);
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

// ---------- API ----------

const no = (reason) => ({ send: false, reason });

export async function decide({ user, candidate, now, flags } = {}) {
  try {
    if (!flags || flags.proactiveEnabled !== true) {
      return no('Proactive notifications are switched off right now.');
    }
    if (!user || user.id == null || user.id === '' || !candidate || typeof candidate.type !== 'string' || !candidate.type) {
      return no('The request is missing the user or the notification type.');
    }
    const nowDate = now instanceof Date ? now : new Date(now);
    const nowMs = nowDate.getTime();
    if (!Number.isFinite(nowMs)) return no('The current time is not valid.');

    return await withLock(user.id, async () => {
      const state = await load(user.id);
      const k = key(candidate.type);

      if (has(state.optedOut, k)) return no('The user switched this notification type off.');

      if (!user.consents || user.consents.marketing !== true) {
        return no('The user has not given consent for this kind of notification.');
      }

      const created = Date.parse(user.createdAt);
      if (Number.isFinite(created) && nowMs - created < NEW_USER_GRACE) {
        return no('The account is less than a day old.');
      }

      const zone = pickZone(user);
      if (!zone) return no("The user's time zone is unknown, so local time cannot be checked.");
      const local = localParts(nowDate, zone);
      if (local.hour < WINDOW_START_HOUR || local.hour >= WINDOW_END_HOUR) {
        return no("It is outside the user's allowed hours (09:00 to 20:00 local time).");
      }

      const d = state.dismissals[k];
      if (d && Number.isFinite(d.last) && nowMs - d.last < DISMISS_FORGET) {
        const pause = DISMISS_PAUSE_DAYS[Math.min(d.count, DISMISS_PAUSE_DAYS.length) - 1] * DAY;
        if (nowMs - d.last < pause) return no('The user dismissed this notification type recently.');
      }

      const recent = state.sent.filter((s) => nowMs - s.at < 2 * DAY && s.at - nowMs < DAY);
      if (recent.some((s) => s.t === candidate.type && Math.abs(nowMs - s.at) < MIN_GAP_SAME_TYPE)) {
        return no('This notification type was already sent in the last day.');
      }
      if (recent.some((s) => s.t === candidate.type && s.day === local.day)) {
        return no('This notification type was already sent today.');
      }
      if (recent.some((s) => Math.abs(nowMs - s.at) < MIN_GAP_ANY_TYPE)) {
        return no('Another notification was sent to this user a short while ago.');
      }
      if (recent.filter((s) => s.day === local.day).length >= MAX_PER_LOCAL_DAY) {
        return no('The user already received the daily maximum of notifications.');
      }

      state.sent = [...recent, { t: candidate.type, at: nowMs, day: local.day }];
      await save(user.id, state);
      return { send: true, reason: null };
    });
  } catch {
    // Fail closed: when the state cannot be read or written, do not send.
    return no('The notification state could not be checked, so nothing was sent.');
  }
}

export async function recordDismissal(userId, type, now) {
  const at = (now instanceof Date ? now : new Date(now ?? Date.now())).getTime();
  await withLock(userId, async () => {
    const state = await load(userId);
    const k = key(type);
    const d = state.dismissals[k];
    const fresh = d && Number.isFinite(d.last) && at - d.last < DISMISS_FORGET;
    state.dismissals[k] = { count: (fresh ? d.count : 0) + 1, last: Math.max(at, fresh ? d.last : at) };
    await save(userId, state);
  });
}

export async function optOut(userId, type) {
  await withLock(userId, async () => {
    const state = await load(userId);
    state.optedOut[key(type)] = true;
    await save(userId, state);
  });
}
