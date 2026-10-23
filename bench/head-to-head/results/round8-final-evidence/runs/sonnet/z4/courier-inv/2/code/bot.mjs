import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, open, unlink, stat } from 'node:fs/promises';
import path from 'node:path';

export const REASON_CODES = [
  'requested_ready',
  'reminder_due',
  'nudge_allowed',
  'already_delivered',
  'new_user_grace_period',
  'daily_nudge_cap_reached',
  'new_user_nudge_limit_reached',
  'nudges_disabled',
  'nudge_too_soon_after_last',
  'quiet_hours',
  'invalid_candidate',
  'unknown_origin',
];

const HOUR = 3600_000;
const DAY = 24 * HOUR;

// Product policy for assistant guesses ("inferred"). Requested things and the
// user's own reminders are never held back by these rules.
const NEW_USER_GRACE_MS = 48 * HOUR; // no inferred nudge in the first 48h
const NEW_USER_PERIOD_MS = 14 * DAY; // while the user is new, at most 1 nudge per day
const NEW_USER_DAILY_CAP = 1;
const MIN_GAP_MS = 4 * HOUR; // minimum time between two nudges
const QUIET_START_HOUR = 21; // local 21:00 up to 08:00
const QUIET_END_HOUR = 8;
const NUDGE_HISTORY_MS = 30 * DAY;
const MAX_DELIVERED_IDS = 2000;

const LOCK_STALE_MS = 15_000;
const LOCK_TIMEOUT_MS = 30_000;

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquireLock(lockPath) {
  const started = Date.now();
  for (;;) {
    try {
      const fh = await open(lockPath, 'wx');
      await fh.close();
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    try {
      const st = await stat(lockPath);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        // rename is atomic: only one process wins the right to remove a stale lock
        const grave = `${lockPath}.stale.${randomUUID()}`;
        await rename(lockPath, grave);
        await unlink(grave).catch(() => {});
        continue;
      }
    } catch {
      continue; // lock vanished or was taken over; retry
    }
    if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error('lock timeout');
    await sleep(5 + Math.random() * 20);
  }
}

async function withUserState(userId, fn) {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const key = createHash('sha256').update(String(userId)).digest('hex');
  const file = path.join(dir, `user-${key}.json`);
  const lock = `${file}.lock`;
  await acquireLock(lock);
  try {
    let state = { delivered: {}, nudges: [] };
    try {
      state = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
    }
    if (!state || typeof state !== 'object') state = {};
    state.delivered ??= {};
    state.nudges ??= [];
    const result = await fn(state);
    if (result.dirty) {
      const tmp = `${file}.tmp.${randomUUID()}`;
      await writeFile(tmp, JSON.stringify(state));
      await rename(tmp, file);
    }
    return result.decision;
  } finally {
    await unlink(lock).catch(() => {});
  }
}

function validTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return typeof tz === 'string' && tz ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

function localParts(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t).value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

function isQuiet(hour) {
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

function parseMs(v) {
  const t = typeof v === 'string' || v instanceof Date ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : NaN;
}

const no = (reasonCode) => ({ send: false, reasonCode });

export async function decide({ user, candidate, now, config } = {}) {
  const nowMs = parseMs(now);
  if (!user?.id || !candidate?.id || !Number.isFinite(nowMs)) return no('invalid_candidate');
  const origin = candidate.origin;
  if (origin !== 'requested' && origin !== 'reminder' && origin !== 'inferred') {
    return no('unknown_origin');
  }

  return withUserState(user.id, (state) => {
    const candKey = String(candidate.id);
    if (state.delivered[candKey]) {
      return { decision: no('already_delivered'), dirty: false };
    }

    const deliver = (reasonCode, isNudge) => {
      state.delivered[candKey] = nowMs;
      const ids = Object.keys(state.delivered);
      if (ids.length > MAX_DELIVERED_IDS) {
        ids
          .sort((a, b) => state.delivered[a] - state.delivered[b])
          .slice(0, ids.length - MAX_DELIVERED_IDS)
          .forEach((k) => delete state.delivered[k]);
      }
      if (isNudge) state.nudges.push(nowMs);
      state.nudges = state.nudges.filter((t) => nowMs - t < NUDGE_HISTORY_MS);
      return { decision: { send: true, reasonCode }, dirty: true };
    };

    if (origin === 'requested') return deliver('requested_ready', false);
    if (origin === 'reminder') return deliver('reminder_due', false);

    // --- inferred: assistant nudge ---
    // The product cap must be a finite non-negative number; anything else means no nudges.
    const cap = Number.isFinite(config?.dailyNudgeCap) ? Math.floor(config.dailyNudgeCap) : 0;
    if (cap <= 0) return { decision: no('nudges_disabled'), dirty: false };

    // Account age: use the newest valid start date. Missing or future dates count as brand new.
    const starts = [parseMs(user.createdAt), parseMs(user.profileCreatedAt)];
    const startMs = starts.every(Number.isFinite) ? Math.max(...starts) : nowMs;
    const age = nowMs - startMs;
    if (age < NEW_USER_GRACE_MS) {
      return { decision: no('new_user_grace_period'), dirty: false };
    }

    const tz = validTimeZone(user.timezone);
    const local = localParts(nowMs, tz);
    if (isQuiet(local.hour)) return { decision: no('quiet_hours'), dirty: false };

    const recent = state.nudges.filter((t) => t <= nowMs);
    const last = recent.length ? Math.max(...recent) : -Infinity;
    if (nowMs - last < MIN_GAP_MS) {
      return { decision: no('nudge_too_soon_after_last'), dirty: false };
    }

    const todayCount = recent.filter((t) => localParts(t, tz).day === local.day).length;
    const isNew = age < NEW_USER_PERIOD_MS;
    const effectiveCap = isNew ? Math.min(cap, NEW_USER_DAILY_CAP) : cap;
    if (todayCount >= effectiveCap) {
      return {
        decision: no(isNew && effectiveCap < cap ? 'new_user_nudge_limit_reached' : 'daily_nudge_cap_reached'),
        dirty: false,
      };
    }

    return deliver('nudge_allowed', true);
  });
}
