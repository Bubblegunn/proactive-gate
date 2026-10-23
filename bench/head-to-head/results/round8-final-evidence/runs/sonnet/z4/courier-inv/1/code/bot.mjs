import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

export const REASON_CODES = [
  'sent_requested',
  'sent_reminder',
  'sent_suggestion',
  'already_delivered',
  'new_user_grace_period',
  'new_user_daily_limit',
  'quiet_hours',
  'daily_cap_reached',
  'too_soon_after_last_nudge',
  'local_time_unknown',
  'account_age_unknown',
  'origin_not_supported',
];

const HOUR = 3600 * 1000;
const GRACE_MS = 48 * HOUR; // no inferred nudges this long after account/profile creation
const RAMP_MS = 7 * 24 * HOUR; // after the grace period, 1 nudge per day until this age
const MIN_GAP_MS = 4 * HOUR; // minimum time between two inferred nudges
const QUIET_START = 21; // local hour, inclusive
const QUIET_END = 9; // local hour, exclusive
const KEEP_NUDGES_MS = 3 * 24 * HOUR;
const KEEP_IDS_MS = 90 * 24 * HOUR;

const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function userFile(dir, userId) {
  const h = createHash('sha256').update(String(userId)).digest('hex');
  return { data: path.join(dir, `user-${h}.json`), lock: path.join(dir, `user-${h}.lock`) };
}

async function withLock(lockPath, fn) {
  const start = Date.now();
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
          // Break a stale lock by renaming it; only one process wins the rename.
          await fs.rename(lockPath, `${lockPath}.stale-${randomUUID()}`).then(
            (r) => r,
            () => {},
          );
          continue;
        }
      } catch {
        continue; // lock vanished; retry
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error('lock timeout');
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
    return {
      ids: s && typeof s.ids === 'object' && s.ids ? s.ids : {},
      nudges: Array.isArray(s?.nudges) ? s.nudges.filter(Number.isFinite) : [],
    };
  } catch {
    return { ids: {}, nudges: [] };
  }
}

async function writeState(file, state) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
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
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
    }).formatToParts(date);
    const get = (t) => parts.find((p) => p.type === t)?.value;
    return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
  } catch {
    return null;
  }
}

function toMs(value) {
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function capFrom(config) {
  const n = config?.dailyNudgeCap;
  return Number.isInteger(n) && n >= 0 ? n : 1; // unknown limit: be conservative
}

export async function decide({ user, candidate, now, config }) {
  const nowMs = toMs(now ?? new Date()) ?? Date.now();
  const origin = candidate?.origin;

  if (origin !== 'requested' && origin !== 'reminder' && origin !== 'inferred') {
    return { send: false, reasonCode: 'origin_not_supported' };
  }

  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const files = userFile(dir, user?.id);
  const candId = candidate?.id == null ? null : String(candidate.id);

  return withLock(files.lock, async () => {
    const state = await readState(files.data);
    for (const [k, t] of Object.entries(state.ids)) {
      if (nowMs - t > KEEP_IDS_MS) delete state.ids[k];
    }
    state.nudges = state.nudges.filter((t) => nowMs - t < KEEP_NUDGES_MS);

    // The same candidate is never delivered twice.
    if (candId !== null && Object.hasOwn(state.ids, candId)) {
      return { send: false, reasonCode: 'already_delivered' };
    }

    const deliver = async (reasonCode, isNudge) => {
      if (candId !== null) state.ids[candId] = nowMs;
      if (isNudge) state.nudges.push(nowMs);
      await writeState(files.data, state);
      return { send: true, reasonCode };
    };

    // The user asked for these: they are not nudges and do not count against the cap.
    if (origin === 'requested') return deliver('sent_requested', false);
    if (origin === 'reminder') return deliver('sent_reminder', false);

    // Inferred suggestion: every guard below can withhold it.
    const created = toMs(user?.createdAt);
    const profile = toMs(user?.profileCreatedAt);
    if (created === null && profile === null) return { send: false, reasonCode: 'account_age_unknown' };
    const startedMs = Math.max(created ?? -Infinity, profile ?? -Infinity);
    const ageMs = nowMs - startedMs;
    if (ageMs < GRACE_MS) return { send: false, reasonCode: 'new_user_grace_period' };

    const local = localParts(new Date(nowMs), user?.timezone);
    if (!local) return { send: false, reasonCode: 'local_time_unknown' };
    if (local.hour >= QUIET_START || local.hour < QUIET_END) {
      return { send: false, reasonCode: 'quiet_hours' };
    }

    const last = state.nudges.length ? Math.max(...state.nudges) : null;
    if (last !== null && nowMs - last < MIN_GAP_MS) {
      return { send: false, reasonCode: 'too_soon_after_last_nudge' };
    }

    const today = state.nudges.filter((t) => localParts(new Date(t), user.timezone)?.day === local.day).length;
    const cap = capFrom(config);
    if (today >= cap) return { send: false, reasonCode: 'daily_cap_reached' };
    if (ageMs < RAMP_MS && today >= 1) return { send: false, reasonCode: 'new_user_daily_limit' };

    return deliver('sent_suggestion', true);
  });
}
