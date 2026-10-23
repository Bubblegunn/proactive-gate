// Morning briefing delivery gate.
//
// Rules, in order of priority (first match gives the reason):
//   1. The user switched the category off (categories[type] === false) or consent for the
//      type is false: nothing is sent, push or in-app.
//   2. The user snoozed (snoozedUntil in the future): nothing is sent until the snooze ends.
//   3. Push only: category never answered (missing), consent store down, OS permission off,
//      dismissal fatigue, quiet hours, and one briefing push per local day.
// In-app items are passive, so they are stored even when only the push is withheld.
// State (dismissals, sent markers) lives in STATE_DIR, one file per user, guarded by a lock
// directory so several worker processes can share it.

import { mkdir, readFile, writeFile, rename, rmdir, stat, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

const WAKE_HOUR = 7; // local time the briefing push goes out
const QUIET_START_HOUR = 22; // push is held from 22:00 to 07:00 local
const DISMISS_LIMIT = 3; // this many swipes of one type ...
const DISMISS_WINDOW_MS = 7 * 24 * 3600 * 1000; // ... inside this window pauses push for the type
const PENDING_TTL_MS = 2 * 60 * 1000; // a claim older than this is treated as a crashed worker
const KEEP_MS = 30 * 24 * 3600 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- state storage ----------

function stateDir() {
  return process.env.STATE_DIR || join(process.cwd(), '.state');
}

function userKey(userId) {
  return 'user-' + createHash('sha1').update(String(userId)).digest('hex');
}

async function withLock(key, fn) {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const lock = join(dir, key + '.lock');
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const s = await stat(lock);
        if (Date.now() - s.mtimeMs > 30000) await rm(lock, { recursive: true, force: true });
      } catch {
        /* lock vanished; retry */
      }
      if (Date.now() - started > 60000) throw new Error('state lock timeout');
      await sleep(3 + Math.random() * 15);
    }
  }
  try {
    return await fn(join(dir, key + '.json'));
  } finally {
    await rmdir(lock).catch(() => {});
  }
}

async function readState(file) {
  try {
    const s = JSON.parse(await readFile(file, 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

async function writeState(file, state) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, file);
}

// ---------- time helpers ----------

function toMs(now) {
  const ms = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);
  return Number.isFinite(ms) ? ms : Date.now();
}

function validZone(tz) {
  if (typeof tz !== 'string' || !tz) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

const formatters = new Map();
function localParts(ms, tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  const p = {};
  for (const { type, value } of f.formatToParts(new Date(ms))) p[type] = Number(value);
  return p;
}

const pad = (n) => String(n).padStart(2, '0');
const localDate = (ms, tz) => {
  const p = localParts(ms, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
};

// UTC instant of the given local wall-clock time (handles DST by iterating on the offset).
function localToUtc(y, mo, d, h, tz) {
  const wall = Date.UTC(y, mo - 1, d, h, 0, 0);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const p = localParts(guess, tz);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess += wall - shown;
  }
  return guess;
}

function inQuietHours(ms, tz) {
  const h = localParts(ms, tz).hour;
  return h < WAKE_HOUR || h >= QUIET_START_HOUR;
}

// First moment at or after ms that is outside quiet hours.
function nextAllowed(ms, tz) {
  if (!inQuietHours(ms, tz)) return ms;
  const p = localParts(ms, tz);
  const dayShift = p.hour >= QUIET_START_HOUR ? 1 : 0;
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day + dayShift));
  return localToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), WAKE_HOUR, tz);
}

function nextWake(ms, tz) {
  const p = localParts(ms, tz);
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return localToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), WAKE_HOUR, tz);
}

// ---------- public API ----------

export async function recordDismissal(userId, type, now) {
  const ms = toMs(now);
  await withLock(userKey(userId), async (file) => {
    const state = await readState(file);
    state.dismissals ??= {};
    const list = (state.dismissals[type] ?? []).filter((t) => t > ms - KEEP_MS);
    list.push(ms);
    state.dismissals[type] = list.slice(-50);
    await writeState(file, state);
  });
}

export async function deliver({ user, candidate, now, transport, consentStore }) {
  const nowMs = toMs(now);
  const type = candidate.type;
  const candId = String(candidate.id);
  const tz = validZone(user.timezone);

  // Whole candidate withheld (both surfaces).
  const hold = (reason, resumeMs = null) => ({
    push: false,
    inApp: false,
    reason,
    resumeAt: resumeMs == null ? null : new Date(resumeMs).toISOString(),
  });

  const category = user.categories ? user.categories[type] : undefined;
  if (category === false) return hold('The user switched off this kind of notification.');

  // Consent. A store outage blocks push (cannot verify) but not the passive in-app item.
  let consents = null;
  let consentDown = false;
  try {
    consents = (await consentStore.get(user.id)) ?? null;
  } catch {
    consentDown = true;
  }
  if (consents && consents[type] === false) return hold('The user has not consented to this kind of notification.');

  let snoozeMs = null;
  if (user.snoozedUntil != null) {
    const s = Date.parse(user.snoozedUntil);
    if (!Number.isFinite(s)) return hold('Notifications are snoozed.');
    if (s > nowMs) snoozeMs = s;
  }
  if (snoozeMs != null) {
    return hold('Notifications are snoozed.', tz ? nextAllowed(snoozeMs, tz) : snoozeMs);
  }

  const key = userKey(user.id);
  const plan = await withLock(key, async (file) => {
    const state = await readState(file);
    state.delivered ??= {};
    state.pushDays ??= {};
    for (const [id, e] of Object.entries(state.delivered)) {
      if (e.at < nowMs - KEEP_MS) delete state.delivered[id];
    }

    // Push blockers: { reason, resumeMs } where resumeMs null means "no known time".
    const blockers = [];
    if (category !== true) {
      blockers.push({ reason: 'The user was never asked about this kind of notification.', resumeMs: null });
    }
    if (consentDown) {
      blockers.push({ reason: 'Consent could not be checked, so no push was sent.', resumeMs: null });
    }
    if (consents && (consents.push === false || consents.notifications === false)) {
      blockers.push({ reason: 'The user has not consented to push notifications.', resumeMs: null });
    }
    if (user.notificationsPermitted === false) {
      blockers.push({ reason: 'Notifications are turned off in the phone settings.', resumeMs: null });
    }

    const recent = (state.dismissals?.[type] ?? [])
      .filter((t) => t > nowMs - DISMISS_WINDOW_MS)
      .sort((a, b) => b - a);
    if (recent.length >= DISMISS_LIMIT) {
      const until = recent[DISMISS_LIMIT - 1] + DISMISS_WINDOW_MS;
      blockers.push({
        reason: 'The user dismissed this kind of notification several times recently.',
        resumeMs: tz ? nextAllowed(until, tz) : until,
      });
    }

    if (!tz) {
      blockers.push({ reason: 'The local time is unknown, so the push was held.', resumeMs: null });
    } else {
      if (inQuietHours(nowMs, tz)) {
        blockers.push({ reason: 'It is night for the user; the push waits until morning.', resumeMs: nextAllowed(nowMs, tz) });
      }
      if (type === 'briefing') {
        const day = state.pushDays[type];
        if (day && day.date === localDate(nowMs, tz) && day.id !== candId) {
          blockers.push({ reason: 'A briefing push was already sent today.', resumeMs: nextWake(nowMs, tz) });
        }
      }
    }

    const entry = (state.delivered[candId] ??= { at: nowMs });
    const busy = (s) => s === 'sent' || (s && s.pending && s.at > nowMs - PENDING_TTL_MS);
    const pushBlocked = blockers.length > 0;
    const doPush = !pushBlocked && !busy(entry.push);
    const doInApp = !busy(entry.inApp);
    const duplicate = (!pushBlocked && !doPush) || !doInApp;
    if (doPush) {
      entry.push = { pending: true, at: nowMs };
      if (type === 'briefing') state.pushDays[type] = { date: localDate(nowMs, tz), id: candId };
    }
    if (doInApp) entry.inApp = { pending: true, at: nowMs };
    await writeState(file, state);
    return { blockers, doPush, doInApp, duplicate };
  });

  // Transport calls run outside the lock.
  let push = false;
  let inApp = false;
  let failure = null;
  if (plan.doPush) {
    try {
      push = (await transport.push(user, candidate)) === true;
    } catch {
      push = false;
    }
    if (!push) failure = 'The phone did not accept the push.';
  }
  if (plan.doInApp) {
    try {
      await transport.inApp(user, candidate);
      inApp = true;
    } catch {
      inApp = false;
    }
  }

  if (plan.doPush || plan.doInApp) {
    await withLock(key, async (file) => {
      const state = await readState(file);
      const entry = state.delivered?.[candId];
      if (!entry) return;
      if (plan.doPush) {
        if (push) entry.push = 'sent';
        else {
          delete entry.push;
          if (state.pushDays?.[type]?.id === candId) delete state.pushDays[type];
        }
      }
      if (plan.doInApp) {
        if (inApp) entry.inApp = 'sent';
        else delete entry.inApp;
      }
      await writeState(file, state);
    });
  }

  // Build the answer.
  let reason = null;
  let resumeAt = null;
  if (plan.blockers.length) {
    reason = plan.blockers[0].reason;
    if (plan.blockers.every((b) => b.resumeMs != null)) {
      resumeAt = new Date(Math.max(...plan.blockers.map((b) => b.resumeMs))).toISOString();
    }
  } else if (failure) {
    reason = inApp ? `${failure} The in-app item was saved instead.` : failure;
  } else if (plan.doInApp && !inApp) {
    reason = 'The in-app item could not be stored.';
  } else if (!push && !inApp && plan.duplicate) {
    reason = 'This briefing was already sent.';
  }
  return { push, inApp, reason, resumeAt };
}
