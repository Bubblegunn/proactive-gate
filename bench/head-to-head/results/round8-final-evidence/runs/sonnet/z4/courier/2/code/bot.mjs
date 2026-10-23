import { promises as fs } from 'node:fs';
import path from 'node:path';

export const REASON_CODES = [
  'sent_requested',
  'sent_reminder',
  'sent_suggestion',
  'already_delivered',
  'new_user_grace_period',
  'daily_limit_reached',
  'too_soon_after_last_suggestion',
  'quiet_hours',
  'suggestions_unavailable',
  'unknown_notification_type',
  'invalid_request',
];

const HOUR = 3600 * 1000;
const NEW_USER_GRACE_MS = 3 * 24 * HOUR; // no assistant guesses for a new user
const MIN_GAP_MS = 4 * HOUR; // between two suggestions
const QUIET_START = 21; // local hour, inclusive
const QUIET_END = 9; // local hour, exclusive
const KEEP_NUDGES_MS = 3 * 24 * HOUR;
const KEEP_IDS_MS = 90 * 24 * HOUR;
const LOCK_STALE_MS = 10000;
const LOCK_TIMEOUT_MS = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function fileKey(id) {
  return encodeURIComponent(String(id)).replace(/\./g, '%2E').slice(0, 180);
}

async function withLock(lockPath, fn) {
  const start = Date.now();
  for (;;) {
    let fh;
    try {
      fh = await fs.open(lockPath, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        continue; // lock vanished, retry
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) throw new Error('lock timeout');
      await sleep(5 + Math.random() * 20);
      continue;
    }
    try {
      await fh.close();
      return await fn();
    } finally {
      await fs.unlink(lockPath).catch(() => {});
    }
  }
}

async function readState(file) {
  try {
    const s = JSON.parse(await fs.readFile(file, 'utf8'));
    return {
      delivered: s && typeof s.delivered === 'object' && s.delivered ? s.delivered : {},
      nudges: Array.isArray(s?.nudges) ? s.nudges.filter((n) => Number.isFinite(n)) : [],
    };
  } catch {
    return { delivered: {}, nudges: [] };
  }
}

async function writeState(file, state) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state));
  await fs.rename(tmp, file);
}

function validZone(tz) {
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

function parseTime(v) {
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
}

export async function decide({ user, candidate, now, config } = {}) {
  const nowMs = parseTime(now);
  if (!user || user.id == null || !candidate || candidate.id == null || !Number.isFinite(nowMs)) {
    return { send: false, reasonCode: 'invalid_request' };
  }
  const origin = candidate.origin;
  if (origin !== 'requested' && origin !== 'inferred' && origin !== 'reminder') {
    return { send: false, reasonCode: 'unknown_notification_type' };
  }

  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const base = path.join(dir, `user-${fileKey(user.id)}`);

  return withLock(`${base}.lock`, async () => {
    const file = `${base}.json`;
    const state = await readState(file);
    const candId = String(candidate.id);

    if (state.delivered[candId] !== undefined) {
      return { send: false, reasonCode: 'already_delivered' };
    }

    const deliver = async (code, isNudge) => {
      state.delivered[candId] = nowMs;
      if (isNudge) state.nudges.push(nowMs);
      for (const [k, t] of Object.entries(state.delivered)) {
        if (nowMs - t > KEEP_IDS_MS) delete state.delivered[k];
      }
      state.nudges = state.nudges.filter((t) => nowMs - t < KEEP_NUDGES_MS);
      await writeState(file, state);
      return { send: true, reasonCode: code };
    };

    // The user asked for these: always delivered, never counted as nudges.
    if (origin === 'requested') return deliver('sent_requested', false);
    if (origin === 'reminder') return deliver('sent_reminder', false);

    // Inferred suggestions: the assistant's own guess, so be conservative.
    const cap = config?.dailyNudgeCap;
    if (!Number.isFinite(cap) || cap < 1) {
      return { send: false, reasonCode: 'suggestions_unavailable' };
    }

    // Grace period counts from the latest known start; unknown dates mean new.
    const starts = [user.createdAt, user.profileCreatedAt].map(parseTime).filter(Number.isFinite);
    const startMs = starts.length ? Math.max(...starts) : nowMs;
    if (nowMs - startMs < NEW_USER_GRACE_MS) {
      return { send: false, reasonCode: 'new_user_grace_period' };
    }

    const tz = validZone(user.timezone);
    const local = localParts(nowMs, tz);
    if (local.hour >= QUIET_START || local.hour < QUIET_END) {
      return { send: false, reasonCode: 'quiet_hours' };
    }

    const today = state.nudges.filter((t) => localParts(t, tz).day === local.day).length;
    if (today >= Math.floor(cap)) {
      return { send: false, reasonCode: 'daily_limit_reached' };
    }

    const last = state.nudges.length ? Math.max(...state.nudges) : -Infinity;
    if (Math.abs(nowMs - last) < MIN_GAP_MS) {
      return { send: false, reasonCode: 'too_soon_after_last_suggestion' };
    }

    return deliver('sent_suggestion', true);
  });
}
