import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const WAKE_HOUR = 7; // push and in-app are held until 07:00 local time
const QUIET_START_HOUR = 22; // 22:00 to 07:00 local is quiet
const DISMISS_LIMIT = 3; // this many dismissals of one type inside the window pauses its push
const DISMISS_WINDOW_MS = 7 * 24 * 3600 * 1000;
const KEEP_MS = 30 * 24 * 3600 * 1000;
const MAX_SENT = 500;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 20_000;

// ---------- time helpers ----------

function toDate(now) {
  const d = now === undefined || now === null ? new Date() : new Date(now);
  if (Number.isNaN(d.getTime())) throw new TypeError('invalid now');
  return d;
}

const fmtCache = new Map();
function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

// Returns local wall-clock parts, or null when the timezone is missing or invalid.
function localParts(date, tz) {
  if (typeof tz !== 'string' || !tz) return null;
  try {
    const o = {};
    for (const p of formatter(tz).formatToParts(date)) o[p.type] = p.value;
    return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second };
  } catch {
    return null;
  }
}

function offsetMs(date, tz) {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// UTC instant at which the wall clock in tz reads y-mo-d hour:00.
function zonedInstant(tz, y, mo, d, hour) {
  const wall = Date.UTC(y, mo - 1, d, hour);
  let t = wall - offsetMs(new Date(wall), tz);
  t = wall - offsetMs(new Date(t), tz);
  return new Date(t);
}

function isQuiet(p) {
  return p.h >= QUIET_START_HOUR || p.h < WAKE_HOUR;
}

// First instant at or after `date` that is not in quiet hours.
function nextAwake(date, tz) {
  const p = localParts(date, tz);
  if (!isQuiet(p)) return date;
  const dayShift = p.h >= QUIET_START_HOUR ? 1 : 0;
  const base = new Date(Date.UTC(p.y, p.mo - 1, p.d + dayShift));
  let t = zonedInstant(tz, base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), WAKE_HOUR);
  if (t <= date) t = new Date(date.getTime() + 60_000); // gap/odd DST edge, never go backwards
  return t;
}

function dayKey(p) {
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

// ---------- shared state (files in STATE_DIR, one lock per user) ----------

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function userPaths(userId) {
  const h = createHash('sha256').update(String(userId)).digest('hex').slice(0, 40);
  const base = path.join(stateDir(), 'users');
  return { base, file: path.join(base, `${h}.json`), lock: path.join(base, `${h}.lock`) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquire(lock) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await mkdir(lock);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    try {
      const st = await stat(lock);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        const grave = `${lock}.stale.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
        try {
          await rename(lock, grave); // only one breaker wins this rename
          await rm(grave, { recursive: true, force: true });
        } catch { /* someone else broke it */ }
        continue;
      }
    } catch { /* lock vanished, retry */ }
    if (Date.now() > deadline) throw new Error('timed out waiting for user state lock');
    await sleep(15 + Math.random() * 35);
  }
}

async function withUser(userId, fn) {
  const { base, file, lock } = userPaths(userId);
  await mkdir(base, { recursive: true });
  await acquire(lock);
  try {
    let state;
    try {
      state = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      state = {};
    }
    state.sent ??= {};
    state.dismissals ??= {};
    state.briefingDays ??= {};
    const result = await fn(state);
    prune(state);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(state));
    await rename(tmp, file);
    return result;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

function prune(state) {
  const cutoff = Date.now() - KEEP_MS;
  for (const [type, list] of Object.entries(state.dismissals)) {
    const kept = list.filter((iso) => Date.parse(iso) > cutoff);
    if (kept.length) state.dismissals[type] = kept;
    else delete state.dismissals[type];
  }
  const ids = Object.keys(state.sent);
  if (ids.length > MAX_SENT) {
    ids.sort((a, b) => Date.parse(state.sent[a].at) - Date.parse(state.sent[b].at));
    for (const id of ids.slice(0, ids.length - MAX_SENT)) delete state.sent[id];
  }
  const days = Object.keys(state.briefingDays).sort();
  for (const k of days.slice(0, Math.max(0, days.length - 60))) delete state.briefingDays[k];
}

// ---------- public API ----------

export async function recordDismissal(userId, type, now) {
  const at = toDate(now).toISOString();
  await withUser(userId, (state) => {
    (state.dismissals[type] ??= []).push(at);
    state.dismissals[type].sort();
  });
}

const withheld = (reason, resumeAt = null) => ({ push: false, inApp: false, reason, resumeAt });

export async function deliver({ user, candidate, now, transport, consentStore }) {
  const nowDate = toDate(now);
  const type = candidate.type;

  // 1. The user switched this kind of notification off. Missing means never asked: not an opt-out.
  if (user.categories && user.categories[type] === false) {
    return withheld(`The user turned off ${type} notifications.`);
  }

  return withUser(user.id, async (state) => {
    // 2. Same candidate already delivered (retry, or two workers): do not send twice.
    const prior = state.sent[candidate.id];
    if (prior) {
      return { push: prior.push, inApp: prior.inApp, reason: 'Already delivered earlier; not sent again.', resumeAt: null };
    }

    // 3. Local time: hold until the user is awake.
    const local = localParts(nowDate, user.timezone);
    const tzKnown = local !== null;
    let resume = null; // latest instant that blocks everything
    let why = null;

    const snoozeMs = user.snoozedUntil ? Date.parse(user.snoozedUntil) : NaN;
    if (!Number.isNaN(snoozeMs) && snoozeMs > nowDate.getTime()) {
      resume = new Date(snoozeMs);
      why = 'The user snoozed notifications.';
    }
    if (tzKnown) {
      const from = resume ?? nowDate;
      if (isQuiet(localParts(from, user.timezone))) {
        resume = nextAwake(from, user.timezone);
        why = why ? 'The user snoozed notifications, and the resume time falls in quiet hours.' : 'It is night for the user; held until they wake up.';
      }
    }
    if (resume) return withheld(why, resume.toISOString());

    // 4. One briefing per local day.
    if (type === 'briefing' && tzKnown) {
      const key = dayKey(local);
      const other = state.briefingDays[key];
      if (other && other !== candidate.id) {
        const next = nextAwake(new Date(zonedInstant(user.timezone, local.y, local.mo, local.d + 1, WAKE_HOUR)), user.timezone);
        return withheld('A briefing was already delivered today.', next.toISOString());
      }
    }

    // 5. Decide whether the push surface is allowed. In-app still gets the item.
    let pushReason = null;
    let pushResume = null;
    if (!tzKnown) pushReason = 'The user timezone is unknown, so no push was sent.';

    if (!pushReason && user.notificationsPermitted === false) {
      pushReason = 'Notifications are turned off for this app in the phone settings; shown in the app only.';
    }

    if (!pushReason) {
      const list = (state.dismissals[type] ?? [])
        .map((iso) => Date.parse(iso))
        .filter((t) => t > nowDate.getTime() - DISMISS_WINDOW_MS && t <= nowDate.getTime())
        .sort((a, b) => a - b);
      if (list.length >= DISMISS_LIMIT) {
        pushReason = `The user dismissed ${type} cards ${list.length} times recently; push paused, shown in the app only.`;
        pushResume = new Date(list[list.length - DISMISS_LIMIT] + DISMISS_WINDOW_MS).toISOString();
      }
    }

    if (!pushReason) {
      try {
        const consents = await consentStore.get(user.id);
        if (!consents || typeof consents !== 'object') {
          pushReason = 'Consent could not be confirmed, so no push was sent; shown in the app only.';
        } else if (consents.push === false || consents.notifications === false || consents[type] === false) {
          pushReason = 'The user has not consented to push notifications; shown in the app only.';
        }
      } catch {
        pushReason = 'Consent could not be checked right now, so no push was sent; shown in the app only.';
      }
    }

    // 6. Send. In-app first so a tapped push finds its item.
    let inApp = false;
    let push = false;
    let failure = null;
    try {
      await transport.inApp(user, candidate);
      inApp = true;
    } catch {
      failure = 'The in-app item could not be stored.';
    }
    if (!pushReason) {
      try {
        push = (await transport.push(user, candidate)) === true;
        if (!push) pushReason = 'The phone did not accept the push (for example no device token); shown in the app only.';
      } catch {
        pushReason = 'The push could not be sent; shown in the app only.';
      }
    }

    if (push || inApp) {
      state.sent[candidate.id] = { push, inApp, at: nowDate.toISOString() };
      if (type === 'briefing' && tzKnown) state.briefingDays[dayKey(local)] = candidate.id;
    }

    const reason = failure ?? pushReason;
    return { push, inApp, reason: reason ?? null, resumeAt: push ? null : pushResume };
  });
}
