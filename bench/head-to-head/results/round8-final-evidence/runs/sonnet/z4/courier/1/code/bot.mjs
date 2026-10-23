import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const REASON_CODES = [
  'requested_ready',
  'reminder_due',
  'nudge_allowed',
  'already_delivered',
  'new_user_grace',
  'quiet_hours',
  'daily_cap_reached',
  'unsupported_origin',
];

const NEW_USER_GRACE_MS = 48 * 60 * 60 * 1000; // no inferred nudges for 48h
const QUIET_START_HOUR = 21; // local time, inclusive
const QUIET_END_HOUR = 9; // local time, exclusive
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 30_000;

function stateDir() {
  return process.env.STATE_DIR || path.join(process.cwd(), '.state');
}

function userFile(dir, userId) {
  const h = crypto.createHash('sha256').update(String(userId)).digest('hex');
  return path.join(dir, `user-${h}.json`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withLock(lockPath, fn) {
  const start = Date.now();
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
      } catch {}
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error('lock timeout');
      await sleep(5 + Math.random() * 20);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rmdir(lockPath).catch(() => {});
  }
}

function localParts(date, timezone) {
  let tz = timezone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    tz = 'UTC';
  }
  const parts = new Intl.DateTimeFormat('en-US', {
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

async function readState(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { delivered: {}, nudges: {} };
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
  if (origin !== 'requested' && origin !== 'inferred' && origin !== 'reminder') {
    return { send: false, reasonCode: 'unsupported_origin' };
  }

  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const file = userFile(dir, user.id);

  return withLock(`${file}.lock`, async () => {
    const state = await readState(file);
    state.delivered ??= {};
    state.nudges ??= {};
    const key = String(candidate.id);

    if (state.delivered[key]) return { send: false, reasonCode: 'already_delivered' };

    const deliver = async (reasonCode, nudgeDay) => {
      state.delivered[key] = now.toISOString();
      if (nudgeDay) state.nudges[nudgeDay] = (state.nudges[nudgeDay] || 0) + 1;
      await writeState(file, state);
      return { send: true, reasonCode };
    };

    // The user asked for these: always delivered (once), never counted as nudges.
    if (origin === 'requested') return deliver('requested_ready');
    if (origin === 'reminder') return deliver('reminder_due');

    // Inferred suggestions: the assistant's own guess, so be conservative.
    const created = Math.max(Date.parse(user.createdAt), Date.parse(user.profileCreatedAt));
    if (!Number.isFinite(created) || now.getTime() - created < NEW_USER_GRACE_MS) {
      return { send: false, reasonCode: 'new_user_grace' };
    }

    const { day, hour } = localParts(now, user.timezone);
    if (hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR) {
      return { send: false, reasonCode: 'quiet_hours' };
    }

    const cap = Number(config?.dailyNudgeCap);
    const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0;
    if ((state.nudges[day] || 0) >= limit) {
      return { send: false, reasonCode: 'daily_cap_reached' };
    }

    return deliver('nudge_allowed', day);
  });
}
