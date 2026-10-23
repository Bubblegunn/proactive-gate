import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const REASON_CODES = [
  'requested_ready',
  'user_reminder',
  'inferred_nudge_allowed',
  'already_delivered',
  'new_user_grace_period',
  'quiet_hours',
  'daily_nudge_cap_reached',
  'unknown_timezone',
  'unknown_origin',
];

const NEW_USER_GRACE_MS = 3 * 24 * 60 * 60 * 1000; // no inferred nudges for the first 3 days
const QUIET_START_HOUR = 21; // local time, inclusive
const QUIET_END_HOUR = 8; // local time, exclusive
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

async function withLock(lockPath, fn) {
  const started = Date.now();
  for (;;) {
    try {
      const fh = await fs.open(lockPath, 'wx');
      await fh.close();
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {}
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error('lock timeout');
      await sleep(5 + Math.random() * 20);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.unlink(lockPath).catch(() => {});
  }
}

async function readState(file) {
  try {
    const s = JSON.parse(await fs.readFile(file, 'utf8'));
    return { delivered: s.delivered ?? {}, nudgeDays: s.nudgeDays ?? {} };
  } catch (e) {
    if (e.code === 'ENOENT') return { delivered: {}, nudgeDays: {} };
    throw e;
  }
}

async function writeState(file, state) {
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

function localParts(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const get = (t) => parts.find((p) => p.type === t).value;
    return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
  } catch {
    return null;
  }
}

function latestAccountStart(user) {
  const times = [user.createdAt, user.profileCreatedAt].map((v) => Date.parse(v));
  if (times.some(Number.isNaN)) return NaN;
  return Math.max(...times);
}

export async function decide({ user, candidate, now, config }) {
  const origin = candidate?.origin;
  if (origin !== 'requested' && origin !== 'reminder' && origin !== 'inferred') {
    return { send: false, reasonCode: 'unknown_origin' };
  }

  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const key = createHash('sha256').update(String(user.id)).digest('hex').slice(0, 32);
  const file = path.join(dir, `user-${key}.json`);

  return withLock(`${file}.lock`, async () => {
    const state = await readState(file);
    const candKey = String(candidate.id);

    if (state.delivered[candKey]) return { send: false, reasonCode: 'already_delivered' };

    let reasonCode;
    let nudgeDay = null;

    if (origin === 'requested') {
      reasonCode = 'requested_ready';
    } else if (origin === 'reminder') {
      reasonCode = 'user_reminder';
    } else {
      // Inferred suggestion: the strictest checks apply.
      const start = latestAccountStart(user);
      if (Number.isNaN(start) || now.getTime() - start < NEW_USER_GRACE_MS) {
        return { send: false, reasonCode: 'new_user_grace_period' };
      }
      const local = localParts(now, user.timezone);
      if (!local) return { send: false, reasonCode: 'unknown_timezone' };
      if (local.hour >= QUIET_START_HOUR || local.hour < QUIET_END_HOUR) {
        return { send: false, reasonCode: 'quiet_hours' };
      }
      const cap = Number.isInteger(config?.dailyNudgeCap) && config.dailyNudgeCap > 0 ? config.dailyNudgeCap : 0;
      if ((state.nudgeDays[local.day] ?? 0) >= cap) {
        return { send: false, reasonCode: 'daily_nudge_cap_reached' };
      }
      nudgeDay = local.day;
      reasonCode = 'inferred_nudge_allowed';
    }

    state.delivered[candKey] = now.toISOString();
    if (nudgeDay) state.nudgeDays[nudgeDay] = (state.nudgeDays[nudgeDay] ?? 0) + 1;
    await writeState(file, state);
    return { send: true, reasonCode };
  });
}
