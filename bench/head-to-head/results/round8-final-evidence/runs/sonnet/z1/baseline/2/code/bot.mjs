import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, rmdir, stat, open } from 'node:fs/promises';
import { join } from 'node:path';

// Policy constants.
const WINDOW_START_HOUR = 9; // local time, inclusive
const WINDOW_END_HOUR = 20; // local time, exclusive (no sends from 20:00 to 08:59)
const MAX_PER_TYPE_PER_DAY = 1;
const MAX_ALL_TYPES_PER_DAY = 2;
const BACKOFF_BASE_DAYS = 2; // after n dismissals wait 2^n days...
const BACKOFF_MAX_DAYS = 30; // ...capped here
const DAY_MS = 86_400_000;
const KEEP_DELIVERIES_MS = 60 * DAY_MS;
const KEEP_IDS = 500;

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 20_000;

const UTC_ALIASES = new Set(['utc', 'etc/utc', 'gmt', 'etc/gmt', 'z', 'zulu', 'etc/zulu', 'universal', 'etc/universal']);

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function userKey(userId) {
  return createHash('sha256').update(String(userId)).digest('hex');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cross-process lock: mkdir is atomic. A lock left by a crashed process is removed after LOCK_STALE_MS.
async function withLock(dir, key, fn) {
  const lock = join(dir, `${key}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          const gone = `${lock}.stale.${process.pid}.${randomBytes(4).toString('hex')}`;
          await rename(lock, gone);
          await rm(gone, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // lock vanished or was taken over; retry
      }
      if (Date.now() > deadline) throw new Error('timed out waiting for state lock');
      await sleep(5 + Math.random() * 20);
    }
  }
  try {
    return await fn();
  } finally {
    await rmdir(lock).catch(() => {});
  }
}

async function loadState(file) {
  try {
    const s = JSON.parse(await readFile(file, 'utf8'));
    if (s && typeof s === 'object') return s;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // Corrupt file: fail closed instead of overwriting opt-outs.
      throw new Error(`unreadable state file ${file}: ${e.message}`);
    }
  }
  return { optedOut: {}, dismissals: {}, deliveries: [], ids: {} };
}

async function saveState(file, state) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(state));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
}

async function mutate(userId, fn) {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const key = userKey(userId);
  const file = join(dir, `${key}.json`);
  return withLock(dir, key, async () => {
    const state = await loadState(file);
    state.optedOut ??= {};
    state.dismissals ??= {};
    state.deliveries ??= [];
    state.ids ??= {};
    const result = await fn(state);
    if (result.dirty) await saveState(file, state);
    return result.value;
  });
}

function validZone(z) {
  if (typeof z !== 'string' || !z) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return true;
  } catch {
    return false;
  }
}

function usableZone(z) {
  return validZone(z) && !UTC_ALIASES.has(z.trim().toLowerCase());
}

// The device zone is where the user is now; the saved zone may be stale or a placeholder.
function pickZone(user) {
  if (usableZone(user.deviceTimezone)) return user.deviceTimezone;
  if (usableZone(user.timezone)) return user.timezone;
  return null;
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

const no = (reason) => ({ send: false, reason });

export async function decide({ user, candidate, now, flags } = {}) {
  try {
    if (!flags || flags.proactiveEnabled !== true) return no('Proactive notifications are switched off right now.');
    if (!user || user.id == null || !candidate || candidate.id == null || typeof candidate.type !== 'string' || !candidate.type) {
      return no('The request is missing user or notification details.');
    }
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return no('The current time is not valid.');

    // Consent: a nudge needs an explicit yes. Missing or empty consents count as no.
    if (user.consents?.marketing !== true) return no('The user has not agreed to receive this kind of notification.');

    const zone = pickZone(user);
    if (!zone) return no('The right time zone for the user is unknown, so local quiet hours cannot be checked.');
    const local = localParts(now, zone);
    if (local.hour < WINDOW_START_HOUR || local.hour >= WINDOW_END_HOUR) {
      return no('It is outside the user\'s local daytime hours (09:00 to 20:00).');
    }

    const type = candidate.type;
    const nowMs = now.getTime();

    return await mutate(user.id, async (state) => {
      if (state.optedOut[type]) return { value: no('The user turned this notification type off.'), dirty: false };

      if (state.ids[candidate.id]) {
        return { value: no('This notification was already delivered.'), dirty: false };
      }

      const d = state.dismissals[type];
      if (d && d.count > 0) {
        const wait = Math.min(BACKOFF_BASE_DAYS ** d.count, BACKOFF_MAX_DAYS) * DAY_MS;
        if (nowMs < d.last + wait) {
          return { value: no('The user recently dismissed this notification type, so we are waiting before trying again.'), dirty: false };
        }
      }

      // Daily caps are counted per local calendar day, using the zone the user is in now.
      const today = state.deliveries.filter((x) => localParts(new Date(x.at), zone).day === local.day);
      if (today.filter((x) => x.type === type).length >= MAX_PER_TYPE_PER_DAY) {
        return { value: no('This notification type was already sent today.'), dirty: false };
      }
      if (today.length >= MAX_ALL_TYPES_PER_DAY) {
        return { value: no('The daily limit of notifications has been reached.'), dirty: false };
      }

      state.deliveries = state.deliveries.filter((x) => nowMs - x.at < KEEP_DELIVERIES_MS);
      state.deliveries.push({ at: nowMs, type, id: candidate.id });
      state.ids[candidate.id] = nowMs;
      const ids = Object.entries(state.ids).sort((a, b) => b[1] - a[1]).slice(0, KEEP_IDS);
      state.ids = Object.fromEntries(ids);
      return { value: { send: true, reason: null }, dirty: true };
    });
  } catch (e) {
    // Fail closed: when unsure, do not notify.
    return no(`Not sent because of an internal error: ${e.message}`);
  }
}

export async function recordDismissal(userId, type, now = new Date()) {
  const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now.getTime() : Date.now();
  await mutate(userId, async (state) => {
    const d = state.dismissals[type] ?? { count: 0, last: 0 };
    // A swipe older than the one stored must not shorten the wait.
    state.dismissals[type] = { count: d.count + 1, last: Math.max(d.last, at) };
    return { dirty: true };
  });
}

export async function optOut(userId, type) {
  await mutate(userId, async (state) => {
    state.optedOut[type] = true;
    return { dirty: true };
  });
}
