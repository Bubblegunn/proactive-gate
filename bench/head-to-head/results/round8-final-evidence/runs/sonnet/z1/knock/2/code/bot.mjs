// Gate for proactive notifications (daily check-in and other types).
// All state lives in files under STATE_DIR, one JSON file per user, guarded by a
// per-user lock file so several worker processes can share it.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const WINDOW_START_HOUR = 9; // local time, inclusive
const WINDOW_END_HOUR = 20; // local time, exclusive
const MIN_GAP_SAME_TYPE_MS = 20 * HOUR;
const MAX_PER_24H_ALL_TYPES = 2;
// Cooldown after the Nth consecutive dismissal of a type: 3 days, 7 days, 30 days, then 90 days.
const DISMISSAL_COOLDOWN_DAYS = [3, 7, 30, 90];
const DISMISSAL_DECAY_MS = 120 * DAY; // old dismissals stop counting after this long
const LOCK_STALE_MS = 15000;
const LOCK_TIMEOUT_MS = 20000;

const PLACEHOLDER_ZONES = new Set(['utc', 'etc/utc', 'gmt', 'etc/gmt', 'z', 'etc/uct', 'uct', 'zulu', 'etc/zulu', 'universal', 'etc/universal']);

const no = (reason) => ({ send: false, reason });

// ---------- helpers ----------

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function userPaths(userId) {
  const h = crypto.createHash('sha256').update(String(userId)).digest('hex');
  const base = path.join(stateDir(), `user-${h}`);
  return { file: `${base}.json`, lock: `${base}.lock` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withLock(userId, fn) {
  const { file, lock } = userPaths(userId);
  await fs.mkdir(stateDir(), { recursive: true });
  const started = Date.now();
  let handle;
  for (;;) {
    try {
      handle = await fs.open(lock, 'wx');
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(lock).catch(() => {});
          continue;
        }
      } catch {
        continue; // lock vanished, retry
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error('could not acquire state lock');
      await sleep(5 + Math.random() * 20);
    }
  }
  try {
    let state = {};
    try {
      state = JSON.parse(await fs.readFile(file, 'utf8')) || {};
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // Corrupt file: keep a copy, start fresh rather than crash every call.
        await fs.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
      }
    }
    state.optedOut ??= {};
    state.lastSent ??= {};
    state.recent ??= [];
    state.sentCandidates ??= {};
    state.dismissals ??= {};
    const result = await fn(state);
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const fh = await fs.open(tmp, 'w');
    try {
      await fh.writeFile(JSON.stringify(state));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, file);
    return result;
  } finally {
    await handle.close().catch(() => {});
    await fs.unlink(lock).catch(() => {});
  }
}

function validZone(z) {
  if (typeof z !== 'string' || !z.trim()) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return z;
  } catch {
    return null;
  }
}

const isPlaceholder = (z) => PLACEHOLDER_ZONES.has(z.trim().toLowerCase());

// The phone's last reported zone is the most recent; the sign-up zone is the fallback.
// "UTC" and similar are placeholders, not a real location, so they are not used.
function resolveZone(user) {
  for (const z of [user.deviceTimezone, user.timezone]) {
    const v = validZone(z);
    if (v && !isPlaceholder(v)) return v;
  }
  return null;
}

function localParts(date, zone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

function toDate(v) {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function activeDismissals(entry, nowMs) {
  if (!entry || !entry.count) return 0;
  return nowMs - entry.last > DISMISSAL_DECAY_MS ? 0 : entry.count;
}

// ---------- public API ----------

export async function decide({ user, candidate, now, flags } = {}) {
  // Emergency switch: fail closed, also when the flags object is missing.
  if (!flags || flags.proactiveEnabled !== true) return no('Proactive notifications are switched off right now.');
  if (!user || user.id == null || user.id === '') return no('The user is unknown.');
  if (!candidate || candidate.id == null || candidate.id === '' || typeof candidate.type !== 'string' || !candidate.type) {
    return no('The notification has no id or type.');
  }
  const nowDate = toDate(now);
  if (!nowDate) return no('The current time is not valid.');
  const nowMs = nowDate.getTime();

  // Consent: proactive nudges need an explicit "marketing" yes. Missing or empty means no.
  if (!user.consents || user.consents.marketing !== true) return no('The user has not agreed to receive this kind of message.');

  const zone = resolveZone(user);
  if (!zone) return no('The time zone of the user is not known, so the local time cannot be checked.');
  const local = localParts(nowDate, zone);
  if (local.hour < WINDOW_START_HOUR || local.hour >= WINDOW_END_HOUR) {
    return no(`It is outside the allowed hours (${WINDOW_START_HOUR}:00 to ${WINDOW_END_HOUR}:00) in the time zone of the user.`);
  }

  const type = candidate.type;
  const cid = String(candidate.id);

  return withLock(user.id, (state) => {
    // Read the opt-out inside the lock, so it is seen by every worker at once.
    if (state.optedOut[type]) return no('The user turned this notification type off.');
    if (state.sentCandidates[cid]) return no('This notification was already delivered.');

    const last = state.lastSent[type];
    if (last != null) {
      if (localParts(new Date(last), zone).day === local.day) return no('This type was already sent today.');
      if (nowMs - last < MIN_GAP_SAME_TYPE_MS) return no('This type was sent too recently.');
    }

    const d = state.dismissals[type];
    const n = activeDismissals(d, nowMs);
    if (n > 0) {
      const days = DISMISSAL_COOLDOWN_DAYS[Math.min(n, DISMISSAL_COOLDOWN_DAYS.length) - 1];
      if (nowMs - d.last < days * DAY) return no('The user dismissed this type recently, so it waits longer.');
    }

    state.recent = state.recent.filter((t) => nowMs - t < DAY && t <= nowMs + HOUR);
    if (state.recent.length >= MAX_PER_24H_ALL_TYPES) return no('The user already got enough notifications in the last 24 hours.');

    // Deliver: record it in the same locked step so no other worker can send a duplicate.
    state.lastSent[type] = nowMs;
    state.recent.push(nowMs);
    state.sentCandidates[cid] = nowMs;
    // Keep the candidate ledger small.
    for (const [k, t] of Object.entries(state.sentCandidates)) if (nowMs - t > 30 * DAY) delete state.sentCandidates[k];
    return { send: true, reason: null };
  });
}

export async function recordDismissal(userId, type, now) {
  const nowDate = toDate(now ?? new Date()) ?? new Date();
  const nowMs = nowDate.getTime();
  await withLock(userId, (state) => {
    const n = activeDismissals(state.dismissals[type], nowMs);
    state.dismissals[type] = { count: n + 1, last: nowMs };
  });
}

export async function optOut(userId, type) {
  await withLock(userId, (state) => {
    state.optedOut[type] = true;
  });
}
