import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, stat, open } from 'node:fs/promises';
import { join } from 'node:path';

// Policy
const WINDOW_START_HOUR = 9; // local time, inclusive
const WINDOW_END_HOUR = 20; // local time, exclusive
const SAME_TYPE_MIN_GAP_MS = 12 * 3600e3; // also guards against time zone changes
const MAX_PER_ROLLING_DAY = 2; // all types together
const DAY_MS = 24 * 3600e3;
const DISMISSAL_MEMORY_MS = 90 * DAY_MS;
const DISMISSAL_BACKOFF_DAYS = [3, 7, 30]; // after the 1st, 2nd, 3rd dismissal
const HISTORY_KEEP_MS = 7 * DAY_MS;
const HISTORY_KEEP_MAX = 50;
const REQUIRED_CONSENT = 'marketing'; // proactive nudges need an explicit "true"

// Locking
const LOCK_STALE_MS = 30e3;
const LOCK_TIMEOUT_MS = 20e3;

const UNKNOWN_ZONES = new Set(['utc', 'etc/utc', 'gmt', 'etc/gmt', 'z', 'zulu', 'etc/zulu', 'universal', 'etc/universal', 'uct', 'etc/uct']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function userKey(userId) {
  return createHash('sha256').update(String(userId)).digest('hex').slice(0, 40);
}

async function withUserLock(userId, fn) {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const key = userKey(userId);
  const lockPath = join(dir, `u-${key}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          // Lock holder crashed. Move the lock away atomically, then retry.
          const dead = `${lockPath}.stale-${randomBytes(4).toString('hex')}`;
          await rename(lockPath, dead).then(() => rm(dead, { recursive: true, force: true }), () => {});
          continue;
        }
      } catch {
        continue; // lock vanished between mkdir and stat
      }
      if (Date.now() > deadline) throw new Error('could not lock user state');
      await sleep(5 + Math.random() * 20);
    }
  }
  try {
    return await fn(join(dir, `u-${key}.json`));
  } finally {
    await rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}

async function loadState(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { optOut: {}, dismissals: {}, sent: [] };
    throw e;
  }
  const s = JSON.parse(text); // a corrupt file throws: callers fail closed
  return {
    optOut: s.optOut && typeof s.optOut === 'object' ? s.optOut : {},
    dismissals: s.dismissals && typeof s.dismissals === 'object' ? s.dismissals : {},
    sent: Array.isArray(s.sent) ? s.sent : [],
  };
}

async function saveState(file, state) {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(state));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
}

// Time zones
const formatters = new Map();
function validZone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return null;
  tz = tz.trim();
  if (UNKNOWN_ZONES.has(tz.toLowerCase())) return null; // "UTC" is a placeholder, not a real location
  try {
    if (!formatters.has(tz)) {
      formatters.set(
        tz,
        new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }),
      );
    }
    return tz;
  } catch {
    return null;
  }
}

function pickZone(user) {
  // The phone's zone is where the user is now; fall back to the signup zone.
  return validZone(user.deviceTimezone) || validZone(user.timezone);
}

function localParts(tz, date) {
  const p = {};
  for (const part of formatters.get(tz).formatToParts(date)) p[part.type] = part.value;
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

// Decision
const no = (reason) => ({ send: false, reason });

async function decideInner({ user, candidate, now, flags }) {
  if (!flags || flags.proactiveEnabled !== true) return no('Proactive notifications are switched off right now.');
  if (!user || user.id == null || user.id === '' || !candidate || !candidate.type || candidate.id == null) {
    return no('The request is missing a user or a candidate.');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return no('The current time is not valid.');

  const type = String(candidate.type);
  const consents = user.consents && typeof user.consents === 'object' ? user.consents : {};
  if (consents[REQUIRED_CONSENT] !== true || consents[type] === false) {
    return no('The user has not given consent for these notifications.');
  }

  const tz = pickZone(user);
  if (!tz) return no('The user\u2019s real time zone is unknown, so the local time cannot be checked.');
  const local = localParts(tz, now);
  if (local.hour < WINDOW_START_HOUR || local.hour >= WINDOW_END_HOUR) {
    return no(`It is outside the allowed hours (${WINDOW_START_HOUR}:00 to ${WINDOW_END_HOUR}:00) in the user's local time.`);
  }

  return withUserLock(user.id, async (file) => {
    const state = await loadState(file);
    const t = now.getTime();

    if (state.optOut[type]) return no('The user switched this notification type off.');

    const dismissals = (Array.isArray(state.dismissals[type]) ? state.dismissals[type] : []).filter(
      (d) => typeof d === 'number' && t - d < DISMISSAL_MEMORY_MS,
    );
    if (dismissals.length > 0) {
      if (dismissals.length > DISMISSAL_BACKOFF_DAYS.length) {
        return no('The user dismissed this notification type several times, so it is paused.');
      }
      const wait = DISMISSAL_BACKOFF_DAYS[dismissals.length - 1] * DAY_MS;
      if (t - Math.max(...dismissals) < wait) return no('The user dismissed this notification type recently.');
    }

    const history = state.sent.filter((s) => s && typeof s.at === 'number');
    if (history.some((s) => s.id === candidate.id)) return no('This notification was already delivered.');

    const sameType = history.filter((s) => s.type === type);
    if (sameType.some((s) => localParts(tz, new Date(s.at)).day === local.day)) {
      return no('This notification type was already delivered today.');
    }
    if (sameType.some((s) => Math.abs(t - s.at) < SAME_TYPE_MIN_GAP_MS)) {
      return no('This notification type was delivered a few hours ago.');
    }
    if (history.filter((s) => Math.abs(t - s.at) < DAY_MS).length >= MAX_PER_ROLLING_DAY) {
      return no('The user already received enough notifications in the last 24 hours.');
    }

    history.push({ id: candidate.id, type, at: t });
    state.sent = history.filter((s) => t - s.at < HISTORY_KEEP_MS).slice(-HISTORY_KEEP_MAX);
    await saveState(file, state);
    return { send: true, reason: null };
  });
}

export async function decide(input) {
  try {
    return await decideInner(input ?? {});
  } catch {
    // Fail closed: when state is unreadable or locked, do not send.
    return no('The notification state could not be checked, so nothing is sent.');
  }
}

export async function recordDismissal(userId, type, now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) now = new Date();
  await withUserLock(userId, async (file) => {
    const state = await loadState(file);
    const list = Array.isArray(state.dismissals[type]) ? state.dismissals[type] : [];
    list.push(now.getTime());
    state.dismissals[type] = list.filter((d) => typeof d === 'number').slice(-20);
    await saveState(file, state);
  });
}

export async function optOut(userId, type) {
  await withUserLock(userId, async (file) => {
    const state = await loadState(file);
    state.optOut[type] = true; // permanent: only an explicit opt-in flow may undo it
    await saveState(file, state);
  });
}
