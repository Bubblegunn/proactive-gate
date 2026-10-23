// Gate for proactive notifications (daily check-in and other types).
// Rules, all checked in decide():
//   1. Kill switch: flags.proactiveEnabled must be true.
//   2. Consent: consents.marketing must be exactly true (missing or empty = no consent).
//   3. Per-type opt-out (optOut) is permanent and survives restarts.
//   4. Local time: only between SEND_START_HOUR and SEND_END_HOUR in the user's zone.
//      The device zone is preferred (current location); the saved signup zone is the
//      fallback. Missing or "UTC" placeholder zones are not trusted: if no real zone
//      is known, nothing is sent.
//   5. Frequency: one per type per local day (and at least MIN_GAP_SAME_TYPE_MS apart),
//      at most MAX_PER_DAY proactive items per local day across all types, and at
//      least MIN_GAP_ANY_MS between any two.
//   6. Dismissal back-off: each dismissal of a type doubles the pause (2, 4, 8 ... days, max 30).
//   7. A candidate id is delivered at most once (retries do not duplicate).
// State is one JSON file per user in STATE_DIR, updated under a per-user lock file so
// several worker processes cannot both send. Any error fails closed (send: false).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SEND_START_HOUR = 9; // inclusive, local
const SEND_END_HOUR = 20; // exclusive, local
const MAX_PER_DAY = 2;
const MIN_GAP_ANY_MS = 4 * 3600e3;
const MIN_GAP_SAME_TYPE_MS = 20 * 3600e3;
const DISMISS_BASE_DAYS = 2;
const DISMISS_MAX_DAYS = 30;
const DISMISS_FORGET_DAYS = 90;
const HISTORY_DAYS = 60;
const MAX_HISTORY = 200;
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 15_000;
const DAY_MS = 86400e3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function userPaths(dir, userId) {
  const h = crypto.createHash('sha256').update(String(userId)).digest('hex');
  return { file: path.join(dir, `user-${h}.json`), lock: path.join(dir, `user-${h}.lock`) };
}

async function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fh = await fs.open(lockPath, 'wx');
      await fh.close();
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    try {
      const st = await fs.stat(lockPath);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        // Rename is atomic: only one process wins the right to remove a stale lock.
        const grave = `${lockPath}.stale-${process.pid}-${crypto.randomUUID()}`;
        try {
          await fs.rename(lockPath, grave);
          await fs.rm(grave, { force: true });
        } catch {}
        continue;
      }
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    if (Date.now() > deadline) throw new Error('could not get state lock');
    await sleep(5 + Math.random() * 20);
  }
}

async function withUserState(userId, fn) {
  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const { file, lock } = userPaths(dir, userId);
  await acquireLock(lock);
  try {
    let state;
    try {
      state = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e; // corrupt file: fail closed, do not reset opt-outs
      state = {};
    }
    state.optOut ??= {};
    state.dismissals ??= {};
    state.sent ??= [];
    const result = await fn(state);
    if (result?.dirty) {
      const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
      const fh = await fs.open(tmp, 'w');
      try {
        await fh.writeFile(JSON.stringify(state));
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.rename(tmp, file);
    }
    return result?.value;
  } finally {
    await fs.rm(lock, { force: true });
  }
}

function validZone(z) {
  if (typeof z !== 'string' || !z || z.toUpperCase() === 'UTC') return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return z;
  } catch {
    return null;
  }
}

function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

const no = (reason) => ({ send: false, reason });

export async function decide({ user, candidate, now, flags } = {}) {
  try {
    if (!flags || flags.proactiveEnabled !== true) return no('Proactive notifications are switched off right now.');
    if (!user || user.id == null || user.id === '') return no('The user is unknown.');
    if (!candidate || typeof candidate.type !== 'string' || !candidate.type || candidate.id == null) {
      return no('The notification is not valid.');
    }
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return no('The current time is not valid.');
    if (user.consents?.marketing !== true) return no('The user has not agreed to this kind of notification.');

    const zone = validZone(user.deviceTimezone) ?? validZone(user.timezone);
    if (!zone) return no("The user's local time is unknown, so quiet hours cannot be checked.");
    const local = localParts(now, zone);
    if (local.hour < SEND_START_HOUR || local.hour >= SEND_END_HOUR) {
      return no(`It is outside the user's allowed hours (${SEND_START_HOUR}:00 to ${SEND_END_HOUR}:00 local time).`);
    }

    const type = candidate.type;
    const id = String(candidate.id);
    const t = now.getTime();

    return await withUserState(user.id, (state) => {
      if (state.optOut[type]) return { value: no('The user switched this notification off.') };

      if (state.sent.some((s) => s.id === id && s.type === type)) {
        return { value: no('This notification was already delivered.') };
      }

      const d = state.dismissals[type];
      if (d && t - d.last < DISMISS_FORGET_DAYS * DAY_MS) {
        const days = Math.min(DISMISS_BASE_DAYS * 2 ** (d.count - 1), DISMISS_MAX_DAYS);
        if (t < d.last + days * DAY_MS) {
          return { value: no('The user dismissed this notification recently, so it is paused for a while.') };
        }
      }

      const lastAny = Math.max(0, ...state.sent.map((s) => s.at));
      if (state.sent.length && Math.abs(t - lastAny) < MIN_GAP_ANY_MS) {
        return { value: no('Another notification was delivered a short time ago.') };
      }
      const lastSame = Math.max(0, ...state.sent.filter((s) => s.type === type).map((s) => s.at));
      if (lastSame && Math.abs(t - lastSame) < MIN_GAP_SAME_TYPE_MS) {
        return { value: no('This kind of notification was already delivered today.') };
      }
      const sameDay = state.sent.filter((s) => s.type === type && localParts(new Date(s.at), zone).day === local.day);
      if (sameDay.length) return { value: no('This kind of notification was already delivered today.') };
      const todayAll = state.sent.filter((s) => localParts(new Date(s.at), zone).day === local.day);
      if (todayAll.length >= MAX_PER_DAY) return { value: no('The daily limit of notifications has been reached.') };

      state.sent.push({ id, type, at: t });
      state.sent = state.sent
        .filter((s) => t - s.at < HISTORY_DAYS * DAY_MS)
        .slice(-MAX_HISTORY);
      return { dirty: true, value: { send: true, reason: null } };
    });
  } catch {
    return no('The notification could not be checked safely, so it was not sent.');
  }
}

export async function recordDismissal(userId, type, now = new Date()) {
  const t = now instanceof Date && !Number.isNaN(now.getTime()) ? now.getTime() : Date.now();
  await withUserState(userId, (state) => {
    const d = state.dismissals[type];
    const fresh = d && t - d.last < DISMISS_FORGET_DAYS * DAY_MS;
    state.dismissals[type] = { count: fresh ? d.count + 1 : 1, last: Math.max(t, d?.last ?? 0) };
    return { dirty: true };
  });
}

export async function optOut(userId, type) {
  await withUserState(userId, (state) => {
    state.optOut[type] = true;
    return { dirty: true };
  });
}
