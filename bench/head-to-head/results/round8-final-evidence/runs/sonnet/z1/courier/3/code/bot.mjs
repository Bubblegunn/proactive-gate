// Gate for proactive notifications (daily check-in and other nudge types).
// State is one JSON file per user in STATE_DIR, changed only while holding a
// per-user lock file, so several worker processes on one machine stay consistent.
// The gate fails closed: if state cannot be read or written, nothing is sent.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const HOUR = 3600e3;
const DAY = 24 * HOUR;

const WINDOW_START_HOUR = 9; // local time, inclusive
const WINDOW_END_HOUR = 20; // local time, exclusive (last send 19:59)
const MAX_PER_TYPE_PER_DAY = 1;
const MAX_PER_USER_PER_DAY = 2;
const MIN_GAP_ANY = 3 * HOUR;
const DISMISSAL_MEMORY = 60 * DAY;
const SENT_MEMORY = 3 * DAY;
const LOCK_STALE_MS = 15e3;
const LOCK_TIMEOUT_MS = 10e3;

// Consent purpose required for proactive nudges. Missing, empty or false means no.
const REQUIRED_CONSENT = 'marketing';

const PLACEHOLDER_ZONES = new Set(['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT', 'Z']);

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function userFile(userId) {
  const h = crypto.createHash('sha256').update(String(userId)).digest('hex');
  return path.join(stateDir(), `user-${h}.json`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withLock(userId, fn) {
  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const lock = userFile(userId) + '.lock';
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fh = await fs.open(lock, 'wx');
      await fh.writeFile(String(process.pid));
      await fh.close();
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          // rename is atomic: only one process wins the right to remove the stale lock
          const grave = `${lock}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
          await fs.rename(lock, grave);
          await fs.rm(grave, { force: true });
          continue;
        }
      } catch {
        continue; // lock vanished or was taken over, retry
      }
      if (Date.now() > deadline) throw new Error('could not get state lock');
      await sleep(10 + Math.random() * 20);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lock, { force: true });
  }
}

const emptyState = () => ({ optedOut: {}, dismissals: {}, sent: [] });

// strict: true throws on unreadable state (decide fails closed);
// strict: false starts from empty state when the file is corrupt.
async function readState(userId, strict) {
  let text;
  try {
    text = await fs.readFile(userFile(userId), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return emptyState();
    throw e;
  }
  try {
    const s = JSON.parse(text);
    return {
      optedOut: s.optedOut && typeof s.optedOut === 'object' ? s.optedOut : {},
      dismissals: s.dismissals && typeof s.dismissals === 'object' ? s.dismissals : {},
      sent: Array.isArray(s.sent) ? s.sent : [],
    };
  } catch (e) {
    if (strict) throw e;
    return emptyState();
  }
}

async function writeState(userId, state) {
  const file = userFile(userId);
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(state));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
}

function validZone(z) {
  if (typeof z !== 'string' || !z) return null;
  if (PLACEHOLDER_ZONES.has(z)) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return z;
  } catch {
    return null;
  }
}

// The phone's last reported zone is the most current; the signup zone is the fallback.
function pickZone(user) {
  return validZone(user.deviceTimezone) || validZone(user.timezone);
}

function localParts(date, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

// Wait after the most recent dismissal, based on how many recent dismissals there were.
function dismissalCooldown(count) {
  if (count <= 0) return 0;
  if (count === 1) return 3 * DAY;
  if (count === 2) return 7 * DAY;
  return 30 * DAY;
}

const no = (reason) => ({ send: false, reason });

export async function decide({ user, candidate, now, flags } = {}) {
  try {
    if (!flags || flags.proactiveEnabled !== true) {
      return no('Proactive notifications are switched off right now.');
    }
    if (!user || user.id == null || !candidate || !candidate.type || candidate.id == null) {
      return no('The request is missing user or notification details.');
    }
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      return no('The current time is not valid.');
    }
    const consents = user.consents;
    if (!consents || typeof consents !== 'object' || consents[REQUIRED_CONSENT] !== true) {
      return no('The user has not agreed to receive these notifications.');
    }
    const zone = pickZone(user);
    if (!zone) return no('The user\'s local time is unknown, so quiet hours cannot be checked.');

    const nowMs = now.getTime();
    const type = String(candidate.type);
    const id = String(candidate.id);
    const local = localParts(now, zone);
    if (local.hour < WINDOW_START_HOUR || local.hour >= WINDOW_END_HOUR) {
      return no('It is outside the user\'s allowed hours (9:00 to 20:00 local time).');
    }

    return await withLock(user.id, async () => {
      const state = await readState(user.id, true);

      if (state.optedOut[type]) return no('The user turned this notification type off.');

      if (state.sent.some((s) => s.id === id && s.type === type)) {
        return no('This notification was already delivered.');
      }

      const recent = (state.dismissals[type] || []).filter((t) => nowMs - t < DISMISSAL_MEMORY && t <= nowMs);
      if (recent.length) {
        const last = Math.max(...recent);
        const wait = dismissalCooldown(recent.length);
        if (nowMs - last < wait) {
          return no('The user recently dismissed this notification type, so it is paused for a while.');
        }
      }

      const sentInDay = (s) => {
        try {
          return localParts(new Date(s.at), zone).day === local.day;
        } catch {
          return false;
        }
      };
      const today = state.sent.filter(sentInDay);
      if (today.filter((s) => s.type === type).length >= MAX_PER_TYPE_PER_DAY) {
        return no('This notification type was already sent today.');
      }
      if (today.length >= MAX_PER_USER_PER_DAY) {
        return no('The user already received the daily maximum of notifications.');
      }
      if (state.sent.some((s) => Math.abs(nowMs - s.at) < MIN_GAP_ANY)) {
        return no('Another notification was sent to this user a short time ago.');
      }

      state.sent = state.sent.filter((s) => nowMs - s.at < SENT_MEMORY);
      state.sent.push({ id, type, at: nowMs });
      await writeState(user.id, state);
      return { send: true, reason: null };
    });
  } catch {
    return no('The notification state could not be checked safely, so nothing was sent.');
  }
}

export async function recordDismissal(userId, type, now) {
  const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now.getTime() : Date.now();
  await withLock(userId, async () => {
    const state = await readState(userId, false);
    const list = (state.dismissals[type] || []).filter((t) => at - t < DISMISSAL_MEMORY);
    list.push(at);
    state.dismissals[type] = list;
    await writeState(userId, state);
  });
}

export async function optOut(userId, type) {
  await withLock(userId, async () => {
    const state = await readState(userId, false);
    state.optedOut[type] = true;
    await writeState(userId, state);
  });
}
