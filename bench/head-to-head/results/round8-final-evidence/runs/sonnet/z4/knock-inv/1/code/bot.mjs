import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Every code decide() can return. The app shows each one to the user as text.
export const REASON_CODES = [
  'sent_requested', // the thing the user asked us to build is ready
  'sent_reminder', // a reminder the user set
  'sent_suggestion', // an assistant suggestion that passed every check
  'already_delivered', // this notification was already delivered once
  'new_user_no_suggestions_yet', // new user: suggestions wait until the user has settled in
  'quiet_hours', // suggestion held back because it is night for the user
  'daily_limit_reached', // suggestion limit for the user's day is used up
  'timezone_unknown', // cannot tell the user's local time, so suggestion held back
  'suggestions_unavailable', // no valid suggestion limit is configured
  'unsupported_origin', // candidate type not recognised
  'invalid_candidate', // candidate has no usable id
  'busy_try_again', // state was locked by other workers, nothing was sent
];

const HOUR = 3600 * 1000;
const NEW_USER_GRACE_MS = 3 * 24 * HOUR; // no suggestions at all
const NEW_USER_RAMP_MS = 14 * 24 * HOUR; // reduced cap after the grace period
const NEW_USER_CAP = 1;
const QUIET_START_HOUR = 21; // local, inclusive
const QUIET_END_HOUR = 9; // local, exclusive
const KEEP_MS = 3 * 24 * HOUR; // how long suggestion timestamps are kept
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 10000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stateDir() {
  return process.env.STATE_DIR || path.join(process.cwd(), '.state');
}

function userKey(id) {
  return crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 40);
}

// Cross-process lock: mkdir is atomic. A lock older than LOCK_STALE_MS is taken over.
async function withLock(dir, fn) {
  const lock = dir + '.lock';
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
        continue; // lock vanished, retry
      }
      if (Date.now() - start > LOCK_WAIT_MS) return null;
      await sleep(5 + Math.random() * 20);
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
    return {
      delivered: Array.isArray(s.delivered) ? s.delivered : [],
      suggestions: Array.isArray(s.suggestions) ? s.suggestions : [],
    };
  } catch {
    return { delivered: [], suggestions: [] };
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

// Local hour and calendar day for a time zone, or null if the zone is invalid.
function localTime(ms, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
    }).formatToParts(new Date(ms));
    const get = (t) => parts.find((p) => p.type === t).value;
    return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
  } catch {
    return null;
  }
}

function validMs(iso) {
  const t = typeof iso === 'string' || iso instanceof Date ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

export async function decide({ user, candidate, now, config } = {}) {
  const no = (reasonCode) => ({ send: false, reasonCode });

  if (!candidate || candidate.id === undefined || candidate.id === null || candidate.id === '') {
    return no('invalid_candidate');
  }
  if (!user || user.id === undefined || user.id === null) return no('invalid_candidate');
  const origin = candidate.origin;
  if (origin !== 'requested' && origin !== 'reminder' && origin !== 'inferred') {
    return no('unsupported_origin');
  }
  const nowMs = now instanceof Date ? now.getTime() : validMs(now);
  if (nowMs === null) return no('invalid_candidate');

  // Cheap checks for suggestions that do not need state.
  let local = null;
  let cap = 0;
  if (origin === 'inferred') {
    // Guardrails first, so a suggestion held back is never recorded.
    const anchors = [validMs(user.createdAt), validMs(user.profileCreatedAt)].filter((t) => t !== null);
    // Age counts from the later of account and profile creation; unknown dates count as brand new.
    const since = anchors.length ? Math.max(...anchors) : nowMs;
    const age = nowMs - since;
    if (age < NEW_USER_GRACE_MS) return no('new_user_no_suggestions_yet');

    const c = config && Number(config.dailyNudgeCap);
    if (!Number.isFinite(c) || c < 1) return no('suggestions_unavailable');
    cap = Math.floor(c);
    if (age < NEW_USER_RAMP_MS) cap = Math.min(cap, NEW_USER_CAP);

    local = localTime(nowMs, user.timezone);
    if (!local) return no('timezone_unknown');
    if (local.hour >= QUIET_START_HOUR || local.hour < QUIET_END_HOUR) return no('quiet_hours');
  }

  const dir = stateDir();
  const file = path.join(dir, `user-${userKey(user.id)}.json`);
  try {
    await fs.mkdir(dir, { recursive: true });
    const result = await withLock(file, async () => {
      const state = await readState(file);
      const cid = String(candidate.id);
      if (state.delivered.includes(cid)) return no('already_delivered');

      if (origin === 'inferred') {
        const today = state.suggestions.filter((t) => {
          const l = localTime(t, user.timezone);
          return l && l.day === local.day;
        }).length;
        if (today >= cap) return no('daily_limit_reached');
        state.suggestions.push(nowMs);
      }
      state.delivered.push(cid);
      state.suggestions = state.suggestions.filter((t) => nowMs - t < KEEP_MS);
      await writeState(file, state);
      return {
        send: true,
        reasonCode:
          origin === 'requested' ? 'sent_requested' : origin === 'reminder' ? 'sent_reminder' : 'sent_suggestion',
      };
    });
    return result || no('busy_try_again');
  } catch {
    // State unavailable: never send blind (could duplicate or exceed the cap).
    return no('busy_try_again');
  }
}
