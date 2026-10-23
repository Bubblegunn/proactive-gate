import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Every code decide() can return. The app translates each one into user-facing text.
export const REASON_CODES = [
  'sent_requested', // the thing the user asked for is ready
  'sent_reminder', // a reminder the user set
  'sent_suggestion', // an assistant suggestion that passed all limits
  'new_user_grace', // suggestions are held back while the user is new
  'daily_nudge_cap_reached', // today's limit for suggestions is used up
  'quiet_hours', // suggestions wait until the user's daytime
  'unknown_timezone', // we cannot tell the user's local time, so we hold suggestions
  'already_delivered', // this notification was already delivered
  'unsupported_origin', // we do not know this kind of notification
  'invalid_request', // missing user or notification data
];

const GRACE_MS = 48 * 3600 * 1000; // no suggestions for the first 48 hours
const NEW_USER_DAYS = 7; // stricter cap during the first week
const NEW_USER_CAP = 1;
const DEFAULT_CAP = 1; // used when config.dailyNudgeCap is missing or invalid
const QUIET_START_HOUR = 21; // local time, inclusive
const QUIET_END_HOUR = 8; // local time, exclusive
const DELIVERED_TTL_MS = 90 * 24 * 3600 * 1000;
const LOCK_STALE_MS = 10000;
const LOCK_TIMEOUT_MS = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function withLock(file, fn) {
  const lock = file + '.lock';
  const start = Date.now();
  for (;;) {
    try {
      const h = await fs.open(lock, 'wx');
      await h.writeFile(String(process.pid));
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
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error('lock timeout');
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
    return { delivered: s.delivered ?? {}, nudges: s.nudges ?? {} };
  } catch {
    return { delivered: {}, nudges: {} };
  }
}

async function writeState(file, state) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const h = await fs.open(tmp, 'w');
  await h.writeFile(JSON.stringify(state));
  await h.sync();
  await h.close();
  await fs.rename(tmp, file);
}

// Local date parts in the user's timezone, or null if the timezone is invalid.
function localParts(date, timeZone) {
  try {
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
  } catch {
    return null;
  }
}

function toMs(v) {
  const t = typeof v === 'string' || v instanceof Date ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : NaN;
}

export async function decide({ user, candidate, now, config } = {}) {
  const nowDate = now instanceof Date && !isNaN(now) ? now : new Date();
  if (!user?.id || !candidate?.id) return { send: false, reasonCode: 'invalid_request' };
  const origin = candidate.origin;
  if (!['requested', 'inferred', 'reminder'].includes(origin)) {
    return { send: false, reasonCode: 'unsupported_origin' };
  }

  const dir = await stateDir();
  const key = crypto.createHash('sha256').update(String(user.id)).digest('hex');
  const file = path.join(dir, `user-${key}.json`);
  const nowMs = nowDate.getTime();

  return withLock(file, async () => {
    const state = await readState(file);
    const cid = String(candidate.id);

    // A notification is delivered at most once.
    if (state.delivered[cid] !== undefined) return { send: false, reasonCode: 'already_delivered' };

    const deliver = async (reasonCode, dayKey) => {
      state.delivered[cid] = nowMs;
      for (const [id, ts] of Object.entries(state.delivered)) {
        if (nowMs - ts > DELIVERED_TTL_MS) delete state.delivered[id];
      }
      if (dayKey) {
        state.nudges[dayKey] = (state.nudges[dayKey] ?? 0) + 1;
        for (const d of Object.keys(state.nudges).sort().slice(0, -7)) delete state.nudges[d];
      }
      await writeState(file, state);
      return { send: true, reasonCode };
    };

    // What the user asked for and what the user scheduled always go out.
    // Neither is a nudge, so neither uses the nudge cap.
    if (origin === 'requested') return deliver('sent_requested');
    if (origin === 'reminder') return deliver('sent_reminder');

    // Inferred suggestions: the strictest path.
    const created = toMs(user.createdAt);
    const profile = toMs(user.profileCreatedAt);
    // Account age counts from the later of the two dates; a missing or future date counts as brand new.
    const known = [created, profile].filter((t) => !isNaN(t) && t <= nowMs);
    const startMs = known.length === 2 ? Math.max(...known) : NaN;
    if (isNaN(startMs) || nowMs - startMs < GRACE_MS) {
      return { send: false, reasonCode: 'new_user_grace' };
    }

    const local = localParts(nowDate, user.timezone);
    if (!local) return { send: false, reasonCode: 'unknown_timezone' };
    if (local.hour >= QUIET_START_HOUR || local.hour < QUIET_END_HOUR) {
      return { send: false, reasonCode: 'quiet_hours' };
    }

    let cap = Number(config?.dailyNudgeCap);
    if (!Number.isFinite(cap) || cap < 0) cap = DEFAULT_CAP;
    cap = Math.floor(cap);
    if (nowMs - startMs < NEW_USER_DAYS * 24 * 3600 * 1000) cap = Math.min(cap, NEW_USER_CAP);
    if ((state.nudges[local.day] ?? 0) >= cap) {
      return { send: false, reasonCode: 'daily_nudge_cap_reached' };
    }
    return deliver('sent_suggestion', local.day);
  });
}
