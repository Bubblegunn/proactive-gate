import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const REASON_CODES = [
  'requested_ready',
  'reminder_due',
  'inferred_allowed',
  'already_delivered',
  'new_user_grace_period',
  'quiet_hours',
  'daily_nudge_cap_reached',
  'invalid_request',
];

const NEW_USER_GRACE_MS = 48 * 60 * 60 * 1000; // no inferred nudges for 48h after the newest of account/profile creation
const QUIET_START = 22; // local hour, inclusive
const QUIET_END = 8; // local hour, exclusive (inferred nudges only)
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function validZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

function localParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: validZone(tz),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

async function withLock(file, fn) {
  const lock = `${file}.lock`;
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
          await fs.rm(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error('lock timeout');
      await sleep(5 + Math.random() * 15);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

async function readState(file) {
  try {
    const s = JSON.parse(await fs.readFile(file, 'utf8'));
    return { delivered: s.delivered ?? {}, nudges: s.nudges ?? {} };
  } catch (e) {
    if (e.code === 'ENOENT') return { delivered: {}, nudges: {} };
    throw e;
  }
}

async function writeState(file, state) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(state));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
}

export async function decide({ user, candidate, now, config } = {}) {
  const time = now instanceof Date ? now : new Date(now);
  if (!user?.id || !candidate?.id || Number.isNaN(time.getTime())) {
    return { send: false, reasonCode: 'invalid_request' };
  }
  const origin = candidate.origin;
  if (!['requested', 'inferred', 'reminder'].includes(origin)) {
    return { send: false, reasonCode: 'invalid_request' };
  }

  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const key = crypto.createHash('sha256').update(String(user.id)).digest('hex').slice(0, 32);
  const file = path.join(dir, `user-${key}.json`);

  return withLock(file, async () => {
    const state = await readState(file);
    const cid = String(candidate.id);

    if (state.delivered[cid]) return { send: false, reasonCode: 'already_delivered' };

    let reasonCode;
    let nudgeDay = null;

    if (origin === 'requested') {
      reasonCode = 'requested_ready';
    } else if (origin === 'reminder') {
      reasonCode = 'reminder_due';
    } else {
      const created = Math.max(Date.parse(user.createdAt), Date.parse(user.profileCreatedAt));
      // unknown dates are treated as a new user (conservative)
      if (Number.isNaN(created) || time.getTime() - created < NEW_USER_GRACE_MS) {
        return { send: false, reasonCode: 'new_user_grace_period' };
      }
      const { day, hour } = localParts(time, user.timezone);
      if (hour >= QUIET_START || hour < QUIET_END) {
        return { send: false, reasonCode: 'quiet_hours' };
      }
      const capRaw = Number(config?.dailyNudgeCap);
      const cap = Number.isFinite(capRaw) ? Math.max(0, Math.floor(capRaw)) : 0;
      if ((state.nudges[day] ?? 0) >= cap) {
        return { send: false, reasonCode: 'daily_nudge_cap_reached' };
      }
      nudgeDay = day;
      reasonCode = 'inferred_allowed';
    }

    state.delivered[cid] = time.toISOString();
    if (nudgeDay) {
      state.nudges[nudgeDay] = (state.nudges[nudgeDay] ?? 0) + 1;
      // keep only recent days
      const days = Object.keys(state.nudges).sort();
      for (const d of days.slice(0, -14)) delete state.nudges[d];
    }
    await writeState(file, state);
    return { send: true, reasonCode };
  });
}
