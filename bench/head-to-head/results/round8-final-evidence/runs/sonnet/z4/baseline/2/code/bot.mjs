import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

export const REASON_CODES = [
  'delivered_requested',
  'delivered_reminder',
  'delivered_suggestion',
  'already_delivered',
  'new_user_grace_period',
  'quiet_hours',
  'daily_suggestion_limit_reached',
  'suggestions_unavailable',
];

const NEW_USER_GRACE_MS = 24 * 60 * 60 * 1000;
const QUIET_START_HOUR = 21; // local, inclusive
const QUIET_END_HOUR = 8; // local, exclusive
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 15_000;
const MAX_DELIVERED_IDS = 5000;
const KEEP_DAYS = 14;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function localParts(date, timezone) {
  let tz = timezone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    tz = 'UTC';
  }
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
      await mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const s = await stat(lock);
        if (Date.now() - s.mtimeMs > LOCK_STALE_MS) {
          await rm(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // lock vanished
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error('lock timeout');
      await sleep(5 + Math.random() * 20);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function readState(file) {
  try {
    const s = JSON.parse(await readFile(file, 'utf8'));
    return {
      delivered: s && typeof s.delivered === 'object' && s.delivered ? s.delivered : {},
      nudges: s && typeof s.nudges === 'object' && s.nudges ? s.nudges : {},
    };
  } catch {
    return { delivered: {}, nudges: {} };
  }
}

async function writeState(file, state) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, file);
}

function prune(state, nowMs) {
  const ids = Object.keys(state.delivered);
  if (ids.length > MAX_DELIVERED_IDS) {
    ids.sort((a, b) => state.delivered[a] - state.delivered[b]);
    for (const id of ids.slice(0, ids.length - MAX_DELIVERED_IDS)) delete state.delivered[id];
  }
  const days = Object.keys(state.nudges).sort();
  for (const d of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete state.nudges[d];
}

function evaluate(state, { user, candidate, now, config }) {
  const nowMs = now.getTime();
  const id = String(candidate.id);

  if (Object.prototype.hasOwnProperty.call(state.delivered, id)) {
    return { send: false, reasonCode: 'already_delivered' };
  }

  if (candidate.origin === 'requested') return { send: true, reasonCode: 'delivered_requested', record: true };
  if (candidate.origin === 'reminder') return { send: true, reasonCode: 'delivered_reminder', record: true };

  // Anything else (inferred, or an unknown origin) is treated as an assistant nudge.
  const created = Date.parse(user.createdAt);
  const profile = Date.parse(user.profileCreatedAt);
  const anchor = Math.max(Number.isFinite(created) ? created : NaN, Number.isFinite(profile) ? profile : NaN);
  if (!Number.isFinite(anchor)) return { send: false, reasonCode: 'suggestions_unavailable' };
  if (nowMs < anchor + NEW_USER_GRACE_MS) return { send: false, reasonCode: 'new_user_grace_period' };

  const { day, hour } = localParts(now, user.timezone);
  if (hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR) return { send: false, reasonCode: 'quiet_hours' };

  const cap = Number(config?.dailyNudgeCap);
  const limit = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 0;
  if ((state.nudges[day] || 0) >= limit) return { send: false, reasonCode: 'daily_suggestion_limit_reached' };

  return { send: true, reasonCode: 'delivered_suggestion', record: true, nudgeDay: day };
}

export async function decide({ user, candidate, now, config }) {
  const fail = candidate?.origin === 'requested' || candidate?.origin === 'reminder';
  try {
    const dir = process.env.STATE_DIR;
    if (!dir) throw new Error('STATE_DIR not set');
    await mkdir(dir, { recursive: true });
    const name = createHash('sha256').update(String(user.id)).digest('hex').slice(0, 32);
    const file = path.join(dir, `${name}.json`);
    return await withLock(dir, name, async () => {
      const state = await readState(file);
      const r = evaluate(state, { user, candidate, now, config });
      if (r.record) {
        state.delivered[String(candidate.id)] = now.getTime();
        if (r.nudgeDay) state.nudges[r.nudgeDay] = (state.nudges[r.nudgeDay] || 0) + 1;
        prune(state, now.getTime());
        await writeState(file, state);
      }
      return { send: r.send, reasonCode: r.reasonCode };
    });
  } catch {
    // State unavailable: never block what the user asked for or set; hold back guesses.
    return fail
      ? { send: true, reasonCode: candidate.origin === 'requested' ? 'delivered_requested' : 'delivered_reminder' }
      : { send: false, reasonCode: 'suggestions_unavailable' };
  }
}
