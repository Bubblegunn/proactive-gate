import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Policy for proactive notifications (daily check-in and similar nudges).
const WINDOW_START_HOUR = 9; // local time, inclusive
const WINDOW_END_HOUR = 20; // local time, exclusive
const MAX_PER_TYPE_PER_DAY = 1;
const MAX_PROACTIVE_PER_DAY = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_BASE_DAYS = 2; // after n dismissals: 2^n days ...
const COOLDOWN_MAX_DAYS = 30; // ... capped here
const DISMISSAL_FORGET_DAYS = 90; // old dismissals stop counting after this long
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 15_000;

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function userKey(userId) {
  return createHash('sha256').update(String(userId)).digest('hex');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cross-process lock: mkdir is atomic. A lock older than LOCK_STALE_MS is taken over.
async function withLock(userId, fn) {
  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const lock = path.join(dir, `${userKey(userId)}.lock`);
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          // rename is atomic: only one process wins the takeover
          const grave = `${lock}.stale.${process.pid}.${Date.now()}`;
          await fs.rename(lock, grave);
          await fs.rm(grave, { recursive: true, force: true });
          continue;
        }
      } catch (e2) {
        if (e2.code === 'ENOENT') continue;
        if (e2.code !== 'ENOTEMPTY' && e2.code !== 'EEXIST') throw e2;
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error('could not get state lock');
      await sleep(5 + Math.random() * 20);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

async function loadState(userId) {
  const file = path.join(stateDir(), `${userKey(userId)}.json`);
  try {
    const s = JSON.parse(await fs.readFile(file, 'utf8'));
    return { optOut: {}, dismissals: {}, sent: {}, ...s };
  } catch (e) {
    if (e.code === 'ENOENT') return { optOut: {}, dismissals: {}, sent: {} };
    throw e;
  }
}

async function saveState(userId, state) {
  const dir = stateDir();
  const file = path.join(dir, `${userKey(userId)}.json`);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(state));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
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

// The device zone is the most recent evidence of where the user is.
// The signup zone is used next, unless it is missing or the "UTC" placeholder.
function resolveZone(user) {
  if (validZone(user.deviceTimezone)) return user.deviceTimezone;
  if (validZone(user.timezone) && user.timezone !== 'UTC') return user.timezone;
  return null;
}

function localParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

function cooldownMs(count) {
  return Math.min(COOLDOWN_BASE_DAYS ** count, COOLDOWN_MAX_DAYS) * DAY_MS;
}

const no = (reason) => ({ send: false, reason });

export async function decide({ user, candidate, now, flags } = {}) {
  if (!user || user.id == null || !candidate || !candidate.type) return no('Missing user or notification details.');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return no('The current time is not valid.');
  if (!flags || flags.proactiveEnabled !== true) return no('Proactive notifications are switched off.');

  const type = String(candidate.type);

  // Cheap checks that need no shared state.
  if (user.consents?.marketing !== true) return no('The user has not agreed to receive these messages.');
  const tz = resolveZone(user);
  if (!tz) return no('The local time zone is unknown, so quiet hours cannot be checked.');
  const local = localParts(now, tz);
  if (local.hour < WINDOW_START_HOUR || local.hour >= WINDOW_END_HOUR) {
    return no('It is outside the allowed hours for the user\'s local time.');
  }

  return withLock(user.id, async () => {
    const state = await loadState(user.id);

    if (state.optOut[type]) return no('The user turned this notification type off.');

    const d = state.dismissals[type];
    if (d && d.count > 0) {
      const last = Date.parse(d.last);
      if (now.getTime() - last > DISMISSAL_FORGET_DAYS * DAY_MS) {
        delete state.dismissals[type];
      } else if (now.getTime() - last < cooldownMs(d.count)) {
        return no('The user dismissed this notification recently, so it is paused for now.');
      }
    }

    const sentToday = (list) => (list || []).filter((iso) => localParts(new Date(iso), tz).day === local.day).length;
    if (sentToday(state.sent[type]) >= MAX_PER_TYPE_PER_DAY) {
      return no('This notification was already sent today.');
    }
    const allToday = Object.values(state.sent).reduce((n, l) => n + sentToday(l), 0);
    if (allToday >= MAX_PROACTIVE_PER_DAY) return no('The daily limit of proactive notifications is reached.');

    // Record the delivery before returning. Keep only recent entries.
    const cutoff = now.getTime() - 3 * DAY_MS;
    const recent = (state.sent[type] || []).filter((iso) => Date.parse(iso) > cutoff);
    recent.push(now.toISOString());
    state.sent[type] = recent;
    await saveState(user.id, state);
    return { send: true, reason: null };
  });
}

export async function recordDismissal(userId, type, now = new Date()) {
  await withLock(userId, async () => {
    const state = await loadState(userId);
    const cur = state.dismissals[type];
    const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
    state.dismissals[type] = { count: (cur?.count || 0) + 1, last: at.toISOString() };
    await saveState(userId, state);
  });
}

export async function optOut(userId, type) {
  await withLock(userId, async () => {
    const state = await loadState(userId);
    state.optOut[type] = true;
    await saveState(userId, state);
  });
}
