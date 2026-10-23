// Gate for proactive notifications (daily check-in and other types).
// Fails closed: any doubt or error means "do not send".
// State: one JSON file per user in STATE_DIR, guarded by a lock file so that
// several worker processes on one machine cannot double-send.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ---- policy ---------------------------------------------------------------
const CONSENT_PURPOSE = 'marketing'; // proactive nudges need an explicit true here
const WINDOW_START_HOUR = 9; // local time, inclusive
const WINDOW_END_HOUR = 20; // local time, exclusive (last send 19:59)
const MIN_GAP_SAME_TYPE_MS = 20 * 3600 * 1000; // also covers DST / travel across zones
const MAX_PROACTIVE_PER_LOCAL_DAY = 2; // all types together
const DISMISS_BACKOFF_DAYS = [3, 7, 14]; // after 1st, 2nd, 3rd dismissal
const DISMISS_LIMIT = DISMISS_BACKOFF_DAYS.length + 1; // this many dismissals = stop for good
const HISTORY_LIMIT = 60;
const LOCK_STALE_MS = 15000;
const LOCK_TIMEOUT_MS = 10000;
const PLACEHOLDER_ZONES = new Set(['UTC', 'ETC/UTC', 'GMT', 'ETC/GMT', 'Z']);

// ---- helpers --------------------------------------------------------------
const no = (reason) => ({ send: false, reason });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function userFile(userId) {
  const h = crypto.createHash('sha256').update(String(userId)).digest('hex');
  return path.join(stateDir(), `user-${h}.json`);
}

async function withLock(userId, fn) {
  await fs.mkdir(stateDir(), { recursive: true });
  const lock = userFile(userId) + '.lock';
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fh = await fs.open(lock, 'wx');
      await fh.close();
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          // Holder probably crashed. Move the lock aside; only one process wins the rename.
          const aside = `${lock}.stale-${process.pid}-${Date.now()}`;
          await fs.rename(lock, aside).catch(() => {});
          await fs.unlink(aside).catch(() => {});
          continue;
        }
      } catch {
        continue; // lock vanished, retry now
      }
      if (Date.now() > deadline) throw new Error('lock timeout');
      await sleep(5 + Math.random() * 15);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.unlink(lock).catch(() => {});
  }
}

async function load(userId) {
  try {
    const s = JSON.parse(await fs.readFile(userFile(userId), 'utf8'));
    return {
      optedOut: s.optedOut ?? {},
      dismissals: s.dismissals ?? {},
      sent: Array.isArray(s.sent) ? s.sent : [],
    };
  } catch (e) {
    if (e.code === 'ENOENT') return { optedOut: {}, dismissals: {}, sent: [] };
    throw e; // corrupt file: fail closed rather than reset the user's opt-outs
  }
}

async function save(userId, state) {
  const file = userFile(userId);
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(state));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
}

function validZone(z) {
  if (typeof z !== 'string' || !z.trim()) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return z;
  } catch {
    return null;
  }
}

function isPlaceholder(z) {
  return PLACEHOLDER_ZONES.has(z.trim().toUpperCase());
}

// The zone the user is in now: the phone's zone first, else the signup zone.
// A missing, invalid or placeholder zone does not count.
function resolveZone(user) {
  for (const z of [user.deviceTimezone, user.timezone]) {
    const v = validZone(z);
    if (v && !isPlaceholder(v)) return v;
  }
  return null;
}

function localParts(ms, zone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t).value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

const validId = (v) => (typeof v === 'string' && v.length > 0) || (typeof v === 'number' && Number.isFinite(v));

// ---- API ------------------------------------------------------------------
export async function decide({ user, candidate, now, flags } = {}) {
  try {
    if (flags?.proactiveEnabled !== true) return no('Proactive notifications are switched off right now.');
    if (!user || !validId(user.id)) return no('The user is unknown.');
    if (!candidate || !validId(candidate.id) || typeof candidate.type !== 'string' || !candidate.type) {
      return no('The notification is not valid.');
    }
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return no('The current time is not valid.');

    if (user.consents?.[CONSENT_PURPOSE] !== true) {
      return no('The user has not given consent for this kind of notification.');
    }

    const zone = resolveZone(user);
    if (!zone) return no('The time zone of the user is not known, so local quiet hours cannot be checked.');

    const nowMs = now.getTime();
    const type = candidate.type;
    const here = localParts(nowMs, zone);
    if (here.hour < WINDOW_START_HOUR || here.hour >= WINDOW_END_HOUR) {
      return no(`It is outside the allowed hours (${WINDOW_START_HOUR}:00 to ${WINDOW_END_HOUR}:00) for the user.`);
    }

    return await withLock(user.id, async () => {
      const state = await load(user.id);

      if (state.optedOut[type]) return no('The user turned this notification type off.');

      const d = state.dismissals[type];
      if (d) {
        if (d.count >= DISMISS_LIMIT) return no('The user dismissed this notification type too many times.');
        if (nowMs < d.until) return no('The user dismissed this notification type recently.');
      }

      if (state.sent.some((s) => s.id === String(candidate.id) && s.type === type)) {
        return no('This notification was already delivered.');
      }

      const lastSame = Math.max(0, ...state.sent.filter((s) => s.type === type).map((s) => s.t));
      if (nowMs - lastSame < MIN_GAP_SAME_TYPE_MS && lastSame > 0) {
        return no('A notification of this type was delivered less than a day ago.');
      }

      const today = state.sent.filter((s) => localParts(s.t, zone).day === here.day).length;
      if (today >= MAX_PROACTIVE_PER_LOCAL_DAY) {
        return no('The user already received enough notifications today.');
      }

      state.sent.push({ id: String(candidate.id), type, t: nowMs });
      state.sent = state.sent.slice(-HISTORY_LIMIT);
      await save(user.id, state);
      return { send: true, reason: null };
    });
  } catch (e) {
    return no(`The decision could not be made safely (${e.message}).`);
  }
}

export async function recordDismissal(userId, type, now) {
  const t = now instanceof Date && !Number.isNaN(now.getTime()) ? now.getTime() : Date.now();
  await withLock(userId, async () => {
    const state = await load(userId);
    const count = (state.dismissals[type]?.count ?? 0) + 1;
    const days = DISMISS_BACKOFF_DAYS[Math.min(count, DISMISS_BACKOFF_DAYS.length) - 1];
    state.dismissals[type] = { count, until: t + days * 86400000, last: t };
    await save(userId, state);
  });
}

export async function optOut(userId, type) {
  await withLock(userId, async () => {
    const state = await load(userId);
    state.optedOut[type] = true;
    await save(userId, state);
  });
}
