import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const REASON_CODES = [
  'delivered',
  'already_delivered',
  'new_user_grace_period',
  'daily_cap_reached',
  'quiet_hours',
  'too_soon_after_last_nudge',
  'nudges_unavailable',
  'unsupported_origin',
  'busy_try_again',
];

const HOUR = 3600 * 1000;
const NEW_USER_GRACE_MS = 24 * HOUR; // no guessed suggestions during the first 24h
const MIN_NUDGE_GAP_MS = 4 * HOUR;
const QUIET_START_HOUR = 21; // local time, inclusive
const QUIET_END_HOUR = 8; // local time, exclusive
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 15_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function localParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

async function withLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
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
      if (Date.now() > deadline) return null;
      await sleep(5 + Math.random() * 20);
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
    return { delivered: s.delivered ?? {}, nudges: Array.isArray(s.nudges) ? s.nudges : [] };
  } catch (e) {
    if (e.code === 'ENOENT') return { delivered: {}, nudges: [] };
    throw e;
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

// Returns a reason code if an inferred nudge must be held back, else null.
function nudgeBlock(user, now, config, state) {
  const cap = config?.dailyNudgeCap;
  if (!Number.isFinite(cap) || cap <= 0) return 'daily_cap_reached';

  const created = [user.createdAt, user.profileCreatedAt].map((d) => Date.parse(d));
  if (created.some(Number.isNaN)) return 'nudges_unavailable';
  const newest = Math.max(...created);
  if (now.getTime() - newest < NEW_USER_GRACE_MS) return 'new_user_grace_period';

  let local;
  try {
    local = localParts(now, user.timezone);
  } catch {
    return 'nudges_unavailable';
  }
  if (local.hour >= QUIET_START_HOUR || local.hour < QUIET_END_HOUR) return 'quiet_hours';

  const t = now.getTime();
  if (state.nudges.some((ts) => Math.abs(t - ts) < MIN_NUDGE_GAP_MS)) {
    // distinguish cap from spacing: cap check first
    const today = state.nudges.filter((ts) => localParts(new Date(ts), user.timezone).day === local.day);
    if (today.length >= cap) return 'daily_cap_reached';
    return 'too_soon_after_last_nudge';
  }
  const today = state.nudges.filter((ts) => localParts(new Date(ts), user.timezone).day === local.day);
  if (today.length >= cap) return 'daily_cap_reached';
  return null;
}

export async function decide({ user, candidate, now, config }) {
  const origin = candidate?.origin;
  if (origin !== 'requested' && origin !== 'inferred' && origin !== 'reminder') {
    return { send: false, reasonCode: 'unsupported_origin' };
  }
  const dir = process.env.STATE_DIR;
  if (!dir) return { send: false, reasonCode: 'busy_try_again' };

  try {
    await fs.mkdir(dir, { recursive: true });
    const key = crypto.createHash('sha256').update(String(user.id)).digest('hex').slice(0, 32);
    const file = path.join(dir, `user-${key}.json`);
    const t = (now instanceof Date ? now : new Date(now)).getTime();
    const nowDate = new Date(t);

    const result = await withLock(file, async () => {
      const state = await readState(file);
      const id = String(candidate.id);
      if (state.delivered[id] !== undefined) return { send: false, reasonCode: 'already_delivered' };

      if (origin === 'inferred') {
        const block = nudgeBlock(user, nowDate, config, state);
        if (block) return { send: false, reasonCode: block };
        state.nudges.push(t);
        // keep only the last 3 days of nudge timestamps
        state.nudges = state.nudges.filter((ts) => t - ts < 72 * HOUR);
      }
      // requested and reminder notifications are what the user asked for:
      // they are never held back by nudge limits and never count toward them.
      state.delivered[id] = t;
      await writeState(file, state);
      return { send: true, reasonCode: 'delivered' };
    });
    return result ?? { send: false, reasonCode: 'busy_try_again' };
  } catch {
    return { send: false, reasonCode: 'busy_try_again' };
  }
}
