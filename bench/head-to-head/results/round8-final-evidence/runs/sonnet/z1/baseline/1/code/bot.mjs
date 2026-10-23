// Gate for proactive notifications (daily check-in and other types).
// Every rule fails closed: when the gate cannot prove a send is allowed, it does not send.
//
// Rules, in the order decide() applies them:
//   1. Kill switch: flags.proactiveEnabled must be exactly true.
//   2. Known type: only "checkin" and "tip" may be sent.
//   3. Consent: user.consents.marketing must be exactly true (missing or empty = no consent).
//      Assumption: check-ins and tips are engagement messages, not transactional ones, so
//      they need the "marketing" purpose.
//   4. Opt-out: a type the user switched off is never sent again.
//   5. Time zone: the zone is the phone's last reported zone, else the saved zone. The saved
//      zone "UTC" is a placeholder and is not trusted. If no real zone is known, do not send.
//   6. Quiet hours: send only between 09:00 and 20:00 local time.
//   7. Duplicates: a candidate id that was already delivered is not delivered again.
//   8. Dismissal back-off: each swipe-away of a type pauses that type for longer.
//   9. Frequency: one per type per local day (and 12 h apart), at most 2 notifications of any
//      type per local day, and at least 4 h between any two notifications.
//
// State: one JSON file per user in STATE_DIR (file name = SHA-256 of the user id), written
// atomically (temp file + fsync + rename) and guarded by a lock file so that several worker
// processes on one machine cannot interleave a read-check-write.

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const KNOWN_TYPES = new Set(['checkin', 'tip']);
const CONSENT_PURPOSE = 'marketing';
const WINDOW_START_HOUR = 9; // inclusive, local time
const WINDOW_END_HOUR = 20; // exclusive, local time
const MIN_GAP_SAME_TYPE = 12 * HOUR;
const MIN_GAP_ANY_TYPE = 4 * HOUR;
const MAX_PER_LOCAL_DAY = 2;
// Pause after the 1st, 2nd, 3rd, and 4th-or-later consecutive dismissal of a type.
const DISMISS_BACKOFF = [3 * DAY, 7 * DAY, 30 * DAY, 90 * DAY];
// A dismissal this long after the previous one starts the count again.
const DISMISS_FORGET = 90 * DAY;
const MAX_SENT_IDS = 500;

const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;

const PLACEHOLDER_ZONES = new Set(['UTC', 'ETC/UTC', 'GMT', 'ETC/GMT']);

// ---------- time zones ----------

const formatters = new Map();

function formatterFor(zone) {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
    });
    formatters.set(zone, f);
  }
  return f;
}

function isValidZone(zone) {
  if (typeof zone !== 'string' || zone.trim() === '') return false;
  try {
    formatterFor(zone);
    return true;
  } catch {
    return false;
  }
}

function resolveZone(user) {
  if (isValidZone(user.deviceTimezone)) return user.deviceTimezone;
  const saved = user.timezone;
  if (isValidZone(saved) && !PLACEHOLDER_ZONES.has(saved.trim().toUpperCase())) return saved;
  return null;
}

function localParts(date, zone) {
  const p = {};
  for (const { type, value } of formatterFor(zone).formatToParts(date)) p[type] = value;
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}

// ---------- state files and locking ----------

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function userFile(userId) {
  const name = createHash('sha256').update(String(userId)).digest('hex');
  return path.join(stateDir(), `${name}.json`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function breakStaleLock(lockPath) {
  let stat;
  try {
    stat = await fs.stat(lockPath);
  } catch {
    return;
  }
  let owner = NaN;
  try {
    owner = Number.parseInt((await fs.readFile(lockPath, 'utf8')).split(':')[0], 10);
  } catch {
    return;
  }
  const dead = Number.isInteger(owner) && owner > 0 && !pidAlive(owner);
  const old = Date.now() - stat.mtimeMs > LOCK_STALE_MS;
  if (!dead && !old) return;
  // Rename first so that only one process removes this particular lock file.
  const grave = `${lockPath}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await fs.rename(lockPath, grave);
    await fs.unlink(grave);
  } catch {
    // Another process won the race.
  }
}

async function withLock(file, fn) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lockPath = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let delay = 2;
  for (;;) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      try {
        await handle.writeFile(`${process.pid}:${Date.now()}`);
      } finally {
        await handle.close();
      }
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      await breakStaleLock(lockPath);
      if (Date.now() > deadline) throw new Error('could not get the state lock in time');
      await sleep(delay + Math.random() * delay);
      delay = Math.min(delay * 2, 50);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.unlink(lockPath).catch(() => {});
  }
}

async function readState(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { v: 1, types: {}, sent: [] };
    throw e;
  }
  // A damaged file is an error, not an empty state: resetting it would forget opt-outs.
  const s = JSON.parse(text);
  if (!s || typeof s !== 'object') throw new Error('state file is damaged');
  s.types = s.types && typeof s.types === 'object' ? s.types : {};
  s.sent = Array.isArray(s.sent) ? s.sent : [];
  return s;
}

async function writeState(file, state) {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify(state));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
  try {
    const dir = await fs.open(path.dirname(file), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    // Directory sync is not supported everywhere; the rename above is already atomic.
  }
}

// Keys are prefixed so a type named "__proto__" cannot touch the object prototype.
const typeKey = (type) => `t:${type}`;

function typeState(state, type) {
  const k = typeKey(type);
  if (!Object.hasOwn(state.types, k)) state.types[k] = {};
  return state.types[k];
}

function toDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------- public API ----------

export async function decide({ user, candidate, now, flags } = {}) {
  const no = (reason) => ({ send: false, reason });

  if (flags?.proactiveEnabled !== true) return no('Proactive notifications are switched off right now.');

  const at = toDate(now);
  if (!at) return no('The current time is not valid.');
  if (!user || typeof user.id !== 'string' || user.id === '') return no('The user is not known.');
  if (!candidate || typeof candidate.id !== 'string' || typeof candidate.type !== 'string' || candidate.id === '') {
    return no('The notification is not valid.');
  }
  if (!KNOWN_TYPES.has(candidate.type)) return no('This notification type is not allowed.');

  if (user.consents?.[CONSENT_PURPOSE] !== true) return no('The user has not agreed to receive these notifications.');

  const zone = resolveZone(user);
  if (!zone) return no("The user's time zone is not known, so quiet hours cannot be checked.");
  const local = localParts(at, zone);
  if (local.hour < WINDOW_START_HOUR || local.hour >= WINDOW_END_HOUR) {
    return no("It is outside the user's allowed hours (09:00 to 20:00 local time).");
  }

  const t = at.getTime();
  const type = candidate.type;

  try {
    const file = userFile(user.id);
    return await withLock(file, async () => {
      const state = await readState(file);
      const ts = typeState(state, type);

      if (ts.optedOut) return no('The user switched this notification type off.');
      if (state.sent.some((s) => s.id === candidate.id)) return no('This notification was already delivered.');
      if (typeof ts.suppressedUntil === 'number' && t < ts.suppressedUntil) {
        return no('The user dismissed this type recently, so it is paused.');
      }

      const recent = state.sent.filter((s) => typeof s.at === 'number');
      const sameType = recent.filter((s) => s.type === type);
      if (sameType.some((s) => s.day === local.day || Math.abs(t - s.at) < MIN_GAP_SAME_TYPE)) {
        return no('This type was already delivered today.');
      }
      if (recent.filter((s) => s.day === local.day).length >= MAX_PER_LOCAL_DAY) {
        return no('The daily limit of notifications was reached.');
      }
      if (recent.some((s) => Math.abs(t - s.at) < MIN_GAP_ANY_TYPE)) {
        return no('Another notification was delivered a short time ago.');
      }

      state.sent.push({ id: candidate.id, type, at: t, day: local.day });
      if (state.sent.length > MAX_SENT_IDS) state.sent.splice(0, state.sent.length - MAX_SENT_IDS);
      await writeState(file, state);
      return { send: true, reason: null };
    });
  } catch {
    return no('The notification state could not be checked, so nothing was sent.');
  }
}

export async function recordDismissal(userId, type, now) {
  const at = toDate(now) ?? new Date();
  const t = at.getTime();
  const file = userFile(userId);
  await withLock(file, async () => {
    const state = await readState(file);
    const ts = typeState(state, String(type));
    const stale = typeof ts.lastDismissedAt === 'number' && t - ts.lastDismissedAt > DISMISS_FORGET;
    ts.dismissals = (stale ? 0 : ts.dismissals || 0) + 1;
    ts.lastDismissedAt = t;
    const pause = DISMISS_BACKOFF[Math.min(ts.dismissals, DISMISS_BACKOFF.length) - 1];
    ts.suppressedUntil = Math.max(ts.suppressedUntil || 0, t + pause);
    await writeState(file, state);
  });
}

export async function optOut(userId, type) {
  const file = userFile(userId);
  await withLock(file, async () => {
    const state = await readState(file);
    typeState(state, String(type)).optedOut = true;
    await writeState(file, state);
  });
}
