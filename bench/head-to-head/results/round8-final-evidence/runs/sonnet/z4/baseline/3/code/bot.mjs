import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const REASON_CODES = [
  'requested_ready',
  'reminder_due',
  'suggestion_allowed',
  'already_delivered',
  'new_user_grace_period',
  'quiet_hours',
  'daily_cap_reached',
  'not_eligible',
];

const HOUR = 3600 * 1000;
const NEW_USER_GRACE_MS = 48 * HOUR; // no inferred suggestions this long after account/profile creation
const QUIET_START = 21; // local hour, inclusive
const QUIET_END = 8; // local hour, exclusive
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 30_000;
const KEEP_MS = 3 * 24 * HOUR; // inferred timestamps kept (cap needs only today)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
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
          await fs.rmdir(lock).catch(() => {});
          continue;
        }
      } catch {}
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error('lock timeout');
      await sleep(5 + Math.random() * 15);
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
      inferred: Array.isArray(s.inferred) ? s.inferred : [],
    };
  } catch (e) {
    if (e.code === 'ENOENT') return { delivered: {}, inferred: [] };
    throw e;
  }
}

async function writeState(file, state) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state));
  await fs.rename(tmp, file);
}

export async function decide({ user, candidate, now, config }) {
  const origin = candidate?.origin;
  const nowDate = now instanceof Date ? now : new Date(now);
  if (
    !user?.id ||
    candidate?.id == null ||
    !['requested', 'inferred', 'reminder'].includes(origin) ||
    Number.isNaN(nowDate.getTime())
  ) {
    return { send: false, reasonCode: 'not_eligible' };
  }

  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const key = crypto.createHash('sha256').update(String(user.id)).digest('hex').slice(0, 32);
  const file = path.join(dir, `user-${key}.json`);
  const nowMs = nowDate.getTime();
  const candId = String(candidate.id);

  return withLock(dir, `user-${key}`, async () => {
    const state = await readState(file);

    if (Object.hasOwn(state.delivered, candId)) {
      return { send: false, reasonCode: 'already_delivered' };
    }

    let reasonCode;
    if (origin === 'requested') {
      reasonCode = 'requested_ready'; // the user asked for it: always deliver
    } else if (origin === 'reminder') {
      reasonCode = 'reminder_due'; // the user set it: always deliver
    } else {
      // inferred suggestion: strictest rules
      const created = [user.createdAt, user.profileCreatedAt]
        .map((d) => new Date(d).getTime())
        .filter((t) => !Number.isNaN(t));
      // missing or invalid dates: treat as brand new
      const newest = created.length === 2 ? Math.max(...created) : nowMs;
      if (nowMs - newest < NEW_USER_GRACE_MS) {
        return { send: false, reasonCode: 'new_user_grace_period' };
      }

      const tz = validTimezone(user.timezone);
      const local = localParts(nowDate, tz);
      if (local.hour >= QUIET_START || local.hour < QUIET_END) {
        return { send: false, reasonCode: 'quiet_hours' };
      }

      const capRaw = config?.dailyNudgeCap;
      const cap = Number.isFinite(capRaw) && capRaw > 0 ? Math.floor(capRaw) : 0;
      const today = state.inferred.filter(
        (t) => t <= nowMs && localParts(new Date(t), tz).day === local.day,
      ).length;
      if (today >= cap) return { send: false, reasonCode: 'daily_cap_reached' };

      state.inferred = state.inferred.filter((t) => nowMs - t < KEEP_MS);
      state.inferred.push(nowMs);
      reasonCode = 'suggestion_allowed';
    }

    state.delivered[candId] = nowMs;
    await writeState(file, state);
    return { send: true, reasonCode };
  });
}
