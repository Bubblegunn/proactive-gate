import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const REASON_CODES = [
  'already_delivered',
  'new_user_grace_period',
  'quiet_hours',
  'daily_nudge_cap_reached',
  'new_user_nudge_limit_reached',
  'nudge_too_soon',
  'nudges_disabled',
  'unsupported_origin',
];

const HOUR = 3600 * 1000;
const GRACE_MS = 24 * HOUR; // no suggestions in the first 24h after the account or profile is created
const NEW_USER_WINDOW_MS = 7 * 24 * HOUR; // first week: at most one suggestion per day
const NEW_USER_DAILY_CAP = 1;
const MIN_NUDGE_GAP_MS = 4 * HOUR;
const QUIET_START_HOUR = 21; // local time, inclusive
const QUIET_END_HOUR = 8; // local time, exclusive
const KEEP_MS = 14 * 24 * HOUR;
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 30_000;

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withLock(lockPath, fn) {
  const start = Date.now();
  for (;;) {
    try {
      const fh = await open(lockPath, 'wx');
      await fh.close();
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const s = await stat(lockPath);
        if (Date.now() - s.mtimeMs > LOCK_STALE_MS) {
          await unlink(lockPath).catch(() => {});
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
    await unlink(lockPath).catch(() => {});
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

function isQuiet(hour) {
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

async function readState(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return { delivered: [] };
  }
}

async function writeState(file, state) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, file);
}

export async function decide({ user, candidate, now, config }) {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const key = createHash('sha256').update(String(user.id)).digest('hex').slice(0, 32);
  const file = path.join(dir, `user-${key}.json`);

  return withLock(`${file}.lock`, async () => {
    const state = await readState(file);
    const nowMs = now.getTime();
    state.delivered = (state.delivered || []).filter((d) => nowMs - d.at < KEEP_MS);

    const deny = (reasonCode) => ({ send: false, reasonCode });
    const record = async () => {
      state.delivered.push({ id: String(candidate.id), origin: candidate.origin, at: nowMs });
      await writeState(file, state);
      return { send: true, reasonCode: null };
    };

    // The same candidate is never delivered twice.
    if (state.delivered.some((d) => d.id === String(candidate.id))) {
      return deny('already_delivered');
    }

    // What the user asked for, or set themselves, is always delivered.
    if (candidate.origin === 'requested' || candidate.origin === 'reminder') {
      return record();
    }
    if (candidate.origin !== 'inferred') return deny('unsupported_origin');

    // Inferred suggestions are nudges: they are limited.
    const cap = Number.isFinite(config?.dailyNudgeCap) ? Math.floor(config.dailyNudgeCap) : 0;
    if (cap <= 0) return deny('nudges_disabled');

    const created = [user.createdAt, user.profileCreatedAt]
      .map((s) => Date.parse(s))
      .filter(Number.isFinite);
    const anchor = created.length ? Math.max(...created) : nowMs;
    const age = nowMs - anchor;
    if (age < GRACE_MS) return deny('new_user_grace_period');

    if (isQuiet(localParts(now, user.timezone).hour)) return deny('quiet_hours');

    const nudges = state.delivered.filter((d) => d.origin === 'inferred');
    const today = localParts(now, user.timezone).day;
    const todayCount = nudges.filter((d) => localParts(new Date(d.at), user.timezone).day === today).length;
    const isNew = age < NEW_USER_WINDOW_MS;
    const effectiveCap = isNew ? Math.min(cap, NEW_USER_DAILY_CAP) : cap;
    if (todayCount >= effectiveCap) {
      return deny(isNew && effectiveCap < cap ? 'new_user_nudge_limit_reached' : 'daily_nudge_cap_reached');
    }

    const last = nudges.reduce((m, d) => Math.max(m, d.at), -Infinity);
    if (nowMs - last < MIN_NUDGE_GAP_MS) return deny('nudge_too_soon');

    return record();
  });
}
