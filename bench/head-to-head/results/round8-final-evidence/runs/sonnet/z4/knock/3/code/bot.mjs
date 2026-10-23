import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Every code decide() can return when send is false.
export const REASON_CODES = [
  'already_delivered', // this candidate id was already delivered
  'new_user_warmup', // user or profile is too new for assistant suggestions
  'new_user_daily_limit', // stricter daily limit during the first week
  'daily_nudge_cap_reached', // dailyNudgeCap suggestions already delivered today
  'nudges_disabled', // dailyNudgeCap is 0 or invalid
  'quiet_hours', // night time in the user's timezone
  'unknown_user_timing', // account dates are missing or unreadable
  'unknown_origin', // origin is not one we deliver
];

const HOUR = 3600 * 1000;
const WARMUP_MS = 24 * HOUR; // no suggestions in the first 24 hours
const NEW_USER_MS = 7 * 24 * HOUR; // first week: at most 1 suggestion per day
const QUIET_START = 22; // local hour, inclusive
const QUIET_END = 8; // local hour, exclusive
const LOCK_STALE_MS = 10_000;
const KEEP_DAYS = 3;

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function localParts(date, timeZone) {
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    });
  }
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cross-process lock: exclusive create of a lock file, stale locks are removed.
async function withLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const h = await fs.open(lock, 'wx');
      await h.close();
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lock).catch(() => {});
          continue;
        }
      } catch {}
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

async function readState(file) {
  try {
    const s = JSON.parse(await fs.readFile(file, 'utf8'));
    return { ids: s.ids ?? {}, nudges: s.nudges ?? {} };
  } catch {
    return { ids: {}, nudges: {} };
  }
}

async function writeState(file, state) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const h = await fs.open(tmp, 'w');
  try {
    await h.writeFile(JSON.stringify(state));
    await h.sync();
  } finally {
    await h.close();
  }
  await fs.rename(tmp, file);
}

export async function decide({ user, candidate, now, config }) {
  const origin = candidate?.origin;
  if (origin !== 'requested' && origin !== 'inferred' && origin !== 'reminder') {
    return { send: false, reasonCode: 'unknown_origin' };
  }

  const nowDate = now instanceof Date ? now : new Date(now);
  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const key = crypto.createHash('sha256').update(String(user.id)).digest('hex').slice(0, 32);
  const file = path.join(dir, `user-${key}.json`);
  const { day, hour } = localParts(nowDate, user.timezone);

  return withLock(file, async () => {
    const state = await readState(file);
    const idKey = String(candidate.id);

    // Retries of an already delivered candidate must not notify twice.
    // Reminders are exempt: a recurring reminder may reuse its id.
    if (origin !== 'reminder' && state.ids[idKey]) {
      return { send: false, reasonCode: 'already_delivered' };
    }

    if (origin === 'inferred') {
      const cap = Number(config?.dailyNudgeCap);
      if (!Number.isFinite(cap) || cap < 1) return { send: false, reasonCode: 'nudges_disabled' };

      const created = Date.parse(user.createdAt);
      const profile = Date.parse(user.profileCreatedAt);
      if (Number.isNaN(created) || Number.isNaN(profile) || Number.isNaN(nowDate.getTime())) {
        return { send: false, reasonCode: 'unknown_user_timing' };
      }
      // A user is as new as the more recent of account and profile.
      const age = nowDate.getTime() - Math.max(created, profile);
      if (age < WARMUP_MS) return { send: false, reasonCode: 'new_user_warmup' };

      if (hour >= QUIET_START || hour < QUIET_END) return { send: false, reasonCode: 'quiet_hours' };

      const today = state.nudges[day] ?? 0;
      if (today >= Math.floor(cap)) return { send: false, reasonCode: 'daily_nudge_cap_reached' };
      if (age < NEW_USER_MS && today >= 1) return { send: false, reasonCode: 'new_user_daily_limit' };

      state.nudges[day] = today + 1;
    }

    if (origin !== 'reminder') state.ids[idKey] = nowDate.toISOString();

    // Drop old per-day counters.
    const days = Object.keys(state.nudges).sort();
    for (const d of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete state.nudges[d];

    await writeState(file, state);
    return { send: true, reasonCode: null };
  });
}
