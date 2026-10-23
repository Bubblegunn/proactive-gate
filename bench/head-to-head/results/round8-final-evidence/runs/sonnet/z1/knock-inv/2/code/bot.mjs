// Gate for proactive notifications (daily check-in nudge and other non-transactional types).
// State is kept per user in STATE_DIR, guarded by a per-user lock so that several worker
// processes on one machine make consistent decisions.
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const SEND_FROM_HOUR = 9; // local time, inclusive
const SEND_UNTIL_HOUR = 20; // local time, exclusive
const MAX_PER_TYPE_PER_DAY = 1;
const MAX_ALL_TYPES_PER_DAY = 2;
const NEW_USER_GRACE_MS = DAY;
const DISMISSAL_COOLDOWN_DAYS = [3, 7, 30]; // after 1, 2, 3+ dismissals
const DISMISSAL_FORGET_MS = 90 * DAY;
const SENT_RETENTION_MS = 7 * DAY;

const LOCK_STALE_MS = 15000;
const LOCK_WAIT_MS = 20000;

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

const userKey = (userId) => createHash('sha256').update(String(userId)).digest('hex');

// ---------- per-user lock and storage ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function acquire(lockPath) {
  const started = Date.now();
  for (;;) {
    try {
      const fh = await open(lockPath, 'wx');
      await fh.writeFile(String(process.pid));
      await fh.close();
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    // Break a lock left behind by a crashed process.
    try {
      const [st, owner] = await Promise.all([stat(lockPath), readFile(lockPath, 'utf8')]);
      const pid = parseInt(owner, 10);
      const dead = Number.isInteger(pid) && !pidAlive(pid);
      if (dead || Date.now() - st.mtimeMs > LOCK_STALE_MS) await rm(lockPath, { force: true });
    } catch {
      /* lock vanished or is being written; retry */
    }
    if (Date.now() - started > LOCK_WAIT_MS) throw new Error('timed out waiting for user state lock');
    await sleep(5 + Math.random() * 15);
  }
}

async function withUser(userId, fn) {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const key = userKey(userId);
  const file = path.join(dir, `${key}.json`);
  const lock = path.join(dir, `${key}.lock`);
  await acquire(lock);
  try {
    let state;
    try {
      state = JSON.parse(await readFile(file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
    }
    state = { optOut: {}, dismissals: {}, sent: [], ...state };
    const result = await fn(state);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state));
    await rename(tmp, file); // atomic replace, survives restarts
    return result;
  } finally {
    await rm(lock, { force: true });
  }
}

// ---------- time zone helpers ----------

function validZone(tz) {
  if (typeof tz !== 'string' || !tz) return null;
  if (tz === 'UTC' || tz === 'Etc/UTC') return null; // placeholder, not a real location
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

// The phone's last reported zone is the best evidence of where the user is now.
function resolveZone(user) {
  return validZone(user.deviceTimezone) ?? validZone(user.timezone);
}

function localParts(date, tz) {
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

// ---------- public API ----------

const no = (reason) => ({ send: false, reason });

export async function decide({ user, candidate, now, flags } = {}) {
  try {
    if (!flags || flags.proactiveEnabled !== true) return no('Proactive notifications are switched off right now.');
    if (!user || user.id == null || !candidate || !candidate.type) return no('Missing user or notification details.');
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return no('The current time is not valid.');

    // Consent: nudges are not transactional, so require an explicit opt-in.
    if (user.consents?.marketing !== true) return no('The user has not agreed to receive these messages.');

    const tz = resolveZone(user);
    if (!tz) return no('The ' + 'user’s time zone is unknown, so local time cannot be checked.');

    const created = Date.parse(user.createdAt);
    if (!Number.isNaN(created) && now.getTime() - created < NEW_USER_GRACE_MS) {
      return no('The account is less than a day old.');
    }

    const { day, hour } = localParts(now, tz);
    if (hour < SEND_FROM_HOUR || hour >= SEND_UNTIL_HOUR) return no('It is outside the allowed hours in the user’s local time.');

    const type = candidate.type;
    return await withUser(user.id, (state) => {
      if (state.optOut[type]) return no('The user turned this notification off.');

      const d = state.dismissals[type];
      if (d && now.getTime() - d.last < DISMISSAL_FORGET_MS) {
        const days = DISMISSAL_COOLDOWN_DAYS[Math.min(d.count, DISMISSAL_COOLDOWN_DAYS.length) - 1];
        if (now.getTime() - d.last < days * DAY) return no('The user recently dismissed this notification.');
      }

      if (candidate.id != null && state.sent.some((s) => s.id === candidate.id)) {
        return no('This notification was already delivered.');
      }

      const today = state.sent.filter((s) => localParts(new Date(s.at), tz).day === day);
      if (today.filter((s) => s.type === type).length >= MAX_PER_TYPE_PER_DAY) {
        return no('This type was already delivered today.');
      }
      if (today.length >= MAX_ALL_TYPES_PER_DAY) return no('The daily notification limit has been reached.');

      state.sent = state.sent.filter((s) => now.getTime() - s.at < SENT_RETENTION_MS);
      state.sent.push({ id: candidate.id ?? null, type, at: now.getTime() });
      return { send: true, reason: null };
    });
  } catch {
    return no('Something went wrong, so nothing was sent.'); // fail closed
  }
}

export async function recordDismissal(userId, type, now = new Date()) {
  const t = now instanceof Date && !Number.isNaN(now.getTime()) ? now.getTime() : Date.now();
  await withUser(userId, (state) => {
    const d = state.dismissals[type];
    const count = d && t - d.last < DISMISSAL_FORGET_MS ? d.count + 1 : 1;
    state.dismissals[type] = { count, last: Math.max(t, d?.last ?? 0) };
  });
}

export async function optOut(userId, type) {
  await withUser(userId, (state) => {
    state.optOut[type] = true;
  });
}
