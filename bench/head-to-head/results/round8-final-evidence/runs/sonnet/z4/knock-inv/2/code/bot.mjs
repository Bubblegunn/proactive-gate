import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const REASON_CODES = [
  'sent_requested',
  'sent_reminder',
  'sent_suggestion',
  'already_delivered',
  'new_user_waiting_period',
  'quiet_hours',
  'daily_limit_reached',
  'unknown_notification_type',
  'missing_user_details',
];

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
// Suggestions the assistant guessed are held back for new users.
const NEW_USER_WAIT_MS = 3 * DAY;
// Suggestions are not sent between 21:00 and 08:00 in the user's local time.
const QUIET_START = 21;
const QUIET_END = 8;
// Delivered ids are remembered this long, to block duplicates.
const ID_MEMORY_MS = 90 * DAY;
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

async function withLock(file, fn) {
  const lock = file + '.lock';
  const start = Date.now();
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const s = await stat(lock);
        if (Date.now() - s.mtimeMs > LOCK_STALE_MS) {
          // Only one process can win this rename, so only one breaks the lock.
          const grave = `${lock}.stale-${randomUUID()}`;
          await rename(lock, grave);
          await rmdir(grave).catch(() => {});
          continue;
        }
      } catch {
        continue; // lock vanished or was taken over; retry
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error('lock timeout');
      await sleep(5 + Math.random() * 20);
    }
  }
  try {
    return await fn();
  } finally {
    await rmdir(lock).catch(() => {});
  }
}

async function readState(file) {
  try {
    const s = JSON.parse(await readFile(file, 'utf8'));
    return {
      delivered: s.delivered && typeof s.delivered === 'object' ? s.delivered : {},
      nudges: s.nudges && typeof s.nudges === 'object' ? s.nudges : {},
    };
  } catch (e) {
    if (e.code === 'ENOENT') return { delivered: {}, nudges: {} };
    throw e;
  }
}

async function writeState(file, state) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, file);
}

function validTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return typeof tz === 'string' && tz ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
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

function inQuietHours(hour) {
  return QUIET_START > QUIET_END
    ? hour >= QUIET_START || hour < QUIET_END
    : hour >= QUIET_START && hour < QUIET_END;
}

export async function decide({ user, candidate, now, config } = {}) {
  if (!user || typeof user.id !== 'string' || !user.id || !candidate || candidate.id == null) {
    return { send: false, reasonCode: 'missing_user_details' };
  }
  const origin = candidate.origin;
  if (origin !== 'requested' && origin !== 'inferred' && origin !== 'reminder') {
    return { send: false, reasonCode: 'unknown_notification_type' };
  }
  const nowDate = now instanceof Date && !isNaN(now) ? now : new Date();
  const nowMs = nowDate.getTime();
  const candId = String(candidate.id);

  // Account age: the newest known start date. Unknown dates count as "new".
  let accountStart = NaN;
  if (origin === 'inferred') {
    const times = [user.createdAt, user.profileCreatedAt].map((d) => Date.parse(d)).filter((t) => !isNaN(t));
    accountStart = times.length ? Math.max(...times) : NaN;
  }

  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `user-${createHash('sha256').update(user.id).digest('hex').slice(0, 32)}.json`);

  return withLock(file, async () => {
    const state = await readState(file);

    for (const [id, t] of Object.entries(state.delivered)) {
      if (nowMs - t > ID_MEMORY_MS) delete state.delivered[id];
    }
    if (state.delivered[candId] !== undefined) {
      return { send: false, reasonCode: 'already_delivered' };
    }

    if (origin === 'requested' || origin === 'reminder') {
      // The user asked for these. They skip quiet hours and the nudge limit.
      state.delivered[candId] = nowMs;
      await writeState(file, state);
      return { send: true, reasonCode: origin === 'requested' ? 'sent_requested' : 'sent_reminder' };
    }

    // origin === 'inferred'
    if (isNaN(accountStart) || nowMs - accountStart < NEW_USER_WAIT_MS) {
      return { send: false, reasonCode: 'new_user_waiting_period' };
    }
    const tz = validTimezone(user.timezone);
    const { day, hour } = localParts(nowDate, tz);
    if (inQuietHours(hour)) {
      return { send: false, reasonCode: 'quiet_hours' };
    }
    const cap = Number.isFinite(config?.dailyNudgeCap) ? Math.max(0, Math.floor(config.dailyNudgeCap)) : 1;
    const sentToday = state.nudges[day] || 0;
    if (sentToday >= cap) {
      return { send: false, reasonCode: 'daily_limit_reached' };
    }
    state.nudges = { [day]: sentToday + 1 };
    state.delivered[candId] = nowMs;
    await writeState(file, state);
    return { send: true, reasonCode: 'sent_suggestion' };
  });
}
