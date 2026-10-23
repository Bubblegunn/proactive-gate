import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const REASON_CODES = [
  'delivered_requested',
  'delivered_reminder',
  'delivered_suggestion',
  'already_delivered',
  'new_user_grace_period',
  'daily_limit_reached',
  'nudges_disabled',
  'quiet_hours',
  'too_soon_after_last_nudge',
  'unrecognized_notification',
];

const HOUR = 3600 * 1000;
const NEW_USER_QUIET_MS = 48 * HOUR; // no guessed suggestions for a new user/profile
const NEW_USER_WINDOW_MS = 7 * 24 * HOUR; // gentler limit while the account is young
const NEW_USER_DAILY_CAP = 1;
const MIN_GAP_MS = 4 * HOUR; // between two suggestions
const QUIET_START_HOUR = 9; // suggestions only from 09:00 ...
const QUIET_END_HOUR = 21; // ... until 20:59 local time

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

async function withLock(dir, name, fn) {
  const lock = path.join(dir, `${name}.lock`);
  const start = Date.now();
  for (;;) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          // atomic rename: only one process can take over a stale lock
          await fs.rename(lock, `${lock}.stale.${process.pid}.${crypto.randomUUID()}`).then(
            (x) => x,
            () => {},
          );
          continue;
        }
      } catch {
        continue; // lock vanished, retry
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error('lock timeout');
      await sleep(3 + Math.random() * 20);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rmdir(lock).catch(() => {});
  }
}

async function readState(file) {
  try {
    const s = JSON.parse(await fs.readFile(file, 'utf8'));
    return {
      delivered: s.delivered && typeof s.delivered === 'object' ? s.delivered : {},
      nudgesByDay: s.nudgesByDay && typeof s.nudgesByDay === 'object' ? s.nudgesByDay : {},
      lastNudgeAt: Number.isFinite(s.lastNudgeAt) ? s.lastNudgeAt : null,
    };
  } catch {
    return { delivered: {}, nudgesByDay: {}, lastNudgeAt: null };
  }
}

async function writeState(file, state) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(state));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
}

function localParts(date, timezone) {
  const make = (tz) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
  let parts;
  try {
    parts = make(timezone || 'UTC');
  } catch {
    parts = make('UTC');
  }
  const g = (t) => parts.find((p) => p.type === t).value;
  return { day: `${g('year')}-${g('month')}-${g('day')}`, hour: Number(g('hour')) };
}

function ms(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export async function decide({ user, candidate, now, config }) {
  const origin = candidate?.origin;
  if (!user?.id || candidate?.id == null || !['requested', 'inferred', 'reminder'].includes(origin)) {
    return { send: false, reasonCode: 'unrecognized_notification' };
  }
  const nowDate = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const nowMs = nowDate.getTime();

  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const name = crypto.createHash('sha256').update(String(user.id)).digest('hex').slice(0, 32);
  const file = path.join(dir, `${name}.json`);
  const key = String(candidate.id);

  return withLock(dir, name, async () => {
    const state = await readState(file);

    if (Object.hasOwn(state.delivered, key)) {
      return { send: false, reasonCode: 'already_delivered' };
    }

    const deliver = async (reasonCode, nudge) => {
      state.delivered[key] = nowMs;
      if (nudge) {
        const { day } = localParts(nowDate, user.timezone);
        state.nudgesByDay[day] = (state.nudgesByDay[day] || 0) + 1;
        state.lastNudgeAt = nowMs;
        // keep only recent day counters
        for (const d of Object.keys(state.nudgesByDay)) {
          if (d < day && Object.keys(state.nudgesByDay).length > 3) delete state.nudgesByDay[d];
        }
      }
      await writeState(file, state);
      return { send: true, reasonCode };
    };

    // The user asked for it or set it themselves: always deliver, once.
    if (origin === 'requested') return deliver('delivered_requested', false);
    if (origin === 'reminder') return deliver('delivered_reminder', false);

    // Inferred suggestion: the strict path.
    const created = [ms(user.createdAt), ms(user.profileCreatedAt)].filter((x) => x !== null);
    const newest = created.length ? Math.max(...created) : nowMs; // unknown dates => treat as new
    const oldest = created.length ? Math.min(...created) : nowMs;
    if (nowMs - newest < NEW_USER_QUIET_MS) {
      return { send: false, reasonCode: 'new_user_grace_period' };
    }

    let cap = Number(config?.dailyNudgeCap);
    if (!Number.isFinite(cap) || cap < 0) cap = 0;
    cap = Math.floor(cap);
    if (cap === 0) return { send: false, reasonCode: 'nudges_disabled' };
    if (nowMs - oldest < NEW_USER_WINDOW_MS) cap = Math.min(cap, NEW_USER_DAILY_CAP);

    const { day, hour } = localParts(nowDate, user.timezone);
    if (hour < QUIET_START_HOUR || hour >= QUIET_END_HOUR) {
      return { send: false, reasonCode: 'quiet_hours' };
    }
    if ((state.nudgesByDay[day] || 0) >= cap) {
      return { send: false, reasonCode: 'daily_limit_reached' };
    }
    if (state.lastNudgeAt !== null && Math.abs(nowMs - state.lastNudgeAt) < MIN_GAP_MS) {
      return { send: false, reasonCode: 'too_soon_after_last_nudge' };
    }
    return deliver('delivered_suggestion', true);
  });
}
