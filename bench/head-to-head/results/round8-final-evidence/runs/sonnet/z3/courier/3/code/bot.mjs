import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const WAKE_HOUR = 7; // earliest local hour for a push
const BRIEFING_END_HOUR = 11; // a morning briefing push is stale after this local hour
const QUIET_START_HOUR = 22; // other pushes stay quiet from here until WAKE_HOUR
const DAY_MS = 24 * 3600 * 1000;
const FATIGUE_COUNT = 3; // this many dismissals of one type ...
const FATIGUE_WINDOW_MS = 7 * DAY_MS; // ... inside this window pause pushes of that type
const PENDING_TTL_MS = 5 * 60 * 1000; // a reservation older than this is a crashed worker
const KEEP_MS = 3 * DAY_MS;
const LOCK_STALE_MS = 10 * 1000;

// ---------- time helpers ----------

function toMs(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  return Date.parse(v);
}

const fmtCache = new Map();
function localParts(ms, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  const p = {};
  for (const { type, value } of f.formatToParts(new Date(ms))) p[type] = Number(value);
  return p;
}

function offsetAt(ms, tz) {
  const p = localParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

// UTC ms of local wall-clock time y-m-d h:00 in tz (day may overflow, Date.UTC normalises).
function localToUtc(y, m, d, h, tz) {
  const guess = Date.UTC(y, m - 1, d, h);
  let t = guess - offsetAt(guess, tz);
  t = guess - offsetAt(t, tz);
  return t;
}

function validZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { localParts(0, tz); return true; } catch { return false; }
}

function dayKey(ms, tz) {
  const p = localParts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// Earliest instant >= fromMs at which a push of this type is allowed by time of day.
function nextPushTime(fromMs, tz, type) {
  const p = localParts(fromMs, tz);
  const wake = (dayOffset) => localToUtc(p.year, p.month, p.day + dayOffset, WAKE_HOUR, tz);
  if (type === 'briefing') {
    if (p.hour < WAKE_HOUR) return wake(0);
    if (p.hour >= BRIEFING_END_HOUR) return wake(1);
    return fromMs;
  }
  if (p.hour < WAKE_HOUR) return wake(0);
  if (p.hour >= QUIET_START_HOUR) return wake(1);
  return fromMs;
}

// ---------- per-user state shared by worker processes ----------

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function userPaths(userId) {
  const h = crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 32);
  const base = path.join(stateDir(), `user-${h}`);
  return { file: `${base}.json`, lock: `${base}.lock` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withLock(userId, fn) {
  await fs.mkdir(stateDir(), { recursive: true });
  const { lock } = userPaths(userId);
  const token = `${process.pid}-${crypto.randomUUID()}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const fh = await fs.open(lock, 'wx');
      await fh.writeFile(token);
      await fh.close();
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          const aside = `${lock}.stale-${crypto.randomUUID()}`;
          await fs.rename(lock, aside);
          await fs.rm(aside, { force: true });
          continue;
        }
      } catch { /* lock vanished, retry */ }
      if (attempt > 2000) throw new Error('could not get state lock');
      await sleep(5 + Math.random() * 15);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lock, { force: true });
  }
}

async function loadState(userId) {
  const { file } = userPaths(userId);
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { sent: {}, dismissals: {}, briefing: null };
    throw e;
  }
  try {
    const s = JSON.parse(raw);
    return { sent: s.sent || {}, dismissals: s.dismissals || {}, briefing: s.briefing || null };
  } catch {
    await fs.rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
    return { sent: {}, dismissals: {}, briefing: null };
  }
}

async function saveState(userId, state, nowMs) {
  for (const [id, rec] of Object.entries(state.sent)) {
    if (nowMs - rec.at > KEEP_MS) delete state.sent[id];
  }
  for (const [type, list] of Object.entries(state.dismissals)) {
    state.dismissals[type] = list.filter((t) => nowMs - t < FATIGUE_WINDOW_MS);
    if (!state.dismissals[type].length) delete state.dismissals[type];
  }
  const { file } = userPaths(userId);
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(state));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
}

// ---------- public API ----------

export async function recordDismissal(userId, type, now) {
  const nowMs = toMs(now ?? Date.now());
  await withLock(userId, async () => {
    const state = await loadState(userId);
    const list = state.dismissals[type] || (state.dismissals[type] = []);
    list.push(nowMs);
    list.sort((a, b) => a - b);
    await saveState(userId, state, nowMs);
  });
}

const iso = (ms) => new Date(ms).toISOString();

export async function deliver({ user, candidate, now, transport, consentStore }) {
  const nowMs = toMs(now);
  const type = candidate.type;
  const out = (push, inApp, reason = null, resumeAt = null) => ({
    push, inApp, reason, resumeAt: resumeAt == null ? null : iso(resumeAt),
  });

  // 1. The user's own choices.
  const choice = user.categories ? user.categories[type] : undefined;
  if (choice === false) {
    return out(false, false, `The user switched off ${type} notifications.`);
  }
  const snoozeMs = user.snoozedUntil ? Date.parse(user.snoozedUntil) : NaN;
  const snoozed = Number.isFinite(snoozeMs) && snoozeMs > nowMs;

  // 2. Time of day in the user's own time zone.
  const zoneOk = validZone(user.timezone);
  const pushFrom = snoozed ? snoozeMs : nowMs;
  const pushAt = zoneOk ? nextPushTime(pushFrom, user.timezone, type) : null;

  if (snoozed) {
    return out(false, false, 'The user snoozed notifications.', pushAt ?? snoozeMs);
  }

  // 3. Push gates, first one that applies gives the reason.
  let pushReason = null;
  let pushResume = null;
  if (choice !== true) {
    pushReason = `The user was never asked about ${type} notifications.`;
  } else if (user.notificationsPermitted === false) {
    pushReason = 'Notifications are turned off in the phone settings.';
  } else if (!zoneOk) {
    pushReason = 'The time zone of the user is unknown, so the local time is unknown.';
  } else if (pushAt > nowMs) {
    pushReason = type === 'briefing' && localParts(nowMs, user.timezone).hour >= BRIEFING_END_HOUR
      ? 'The morning window has passed; the next briefing push goes out tomorrow morning.'
      : 'It is night for the user; the push waits until morning.';
    pushResume = pushAt;
  }

  if (!pushReason) {
    let consents;
    try {
      consents = (await consentStore.get(user.id)) || {};
    } catch {
      pushReason = 'Consent could not be checked, so no push was sent.';
    }
    if (consents) {
      if (consents.push === false || consents.notifications === false) {
        pushReason = 'The user did not consent to push notifications.';
      } else if (type !== 'briefing' && consents.marketing === false) {
        pushReason = 'The user did not consent to marketing messages.';
      }
    }
  }

  // 4. Reserve under lock: duplicates, daily cap, dismissal fatigue.
  const tz = zoneOk ? user.timezone : 'UTC';
  const today = dayKey(nowMs, tz);
  const plan = await withLock(user.id, async () => {
    const state = await loadState(user.id);
    const rec = state.sent[candidate.id] || (state.sent[candidate.id] = { at: nowMs });
    const res = { doPush: false, doInApp: false, pushReason, pushResume, inAppDone: rec.inApp === true, pushDone: rec.push === true, busy: false };
    const fresh = (v) => v && typeof v === 'object' && nowMs - v.pending < PENDING_TTL_MS;
    if (fresh(rec.push) || fresh(rec.inApp)) res.busy = true;

    if (!res.inAppDone && !fresh(rec.inApp)) {
      rec.inApp = { pending: nowMs };
      res.doInApp = true;
    }

    if (!res.pushReason && !res.pushDone && !fresh(rec.push)) {
      const list = (state.dismissals[type] || []).filter((t) => nowMs - t < FATIGUE_WINDOW_MS);
      if (list.length >= FATIGUE_COUNT) {
        res.pushReason = `The user dismissed ${type} cards several times, so pushes are paused.`;
        res.pushResume = list[list.length - FATIGUE_COUNT] + FATIGUE_WINDOW_MS;
      } else if (type === 'briefing' && state.briefing && state.briefing.day === today && state.briefing.id !== candidate.id
        && (state.briefing.done || nowMs - state.briefing.at < PENDING_TTL_MS)) {
        res.pushReason = 'A briefing push already went out today.';
        res.pushResume = localToUtc(...nextDayParts(nowMs, tz), WAKE_HOUR, tz);
      } else {
        rec.push = { pending: nowMs };
        if (type === 'briefing') state.briefing = { day: today, id: candidate.id, at: nowMs, done: false };
        res.doPush = true;
      }
    }
    rec.at = nowMs;
    await saveState(user.id, state, nowMs);
    return res;
  });

  // 5. Send outside the lock.
  let pushed = plan.pushDone;
  let stored = plan.inAppDone;
  let pushOutcome = null; // 'ok' | 'rejected' | 'error'
  let inAppOutcome = null;
  let error = null;

  if (plan.doPush) {
    try {
      pushed = (await transport.push(user, candidate)) === true;
      pushOutcome = pushed ? 'ok' : 'rejected';
    } catch (e) {
      pushOutcome = 'error';
      error = e;
    }
  }
  if (plan.doInApp) {
    try {
      await transport.inApp(user, candidate);
      stored = true;
      inAppOutcome = 'ok';
    } catch (e) {
      inAppOutcome = 'error';
      error ??= e;
    }
  }

  // 6. Record the outcome so retries and other workers see it.
  if (plan.doPush || plan.doInApp) {
    await withLock(user.id, async () => {
      const state = await loadState(user.id);
      const rec = state.sent[candidate.id] || (state.sent[candidate.id] = { at: nowMs });
      if (plan.doPush) {
        if (pushOutcome === 'ok') rec.push = true;
        else delete rec.push;
        if (type === 'briefing' && state.briefing && state.briefing.id === candidate.id) {
          if (pushOutcome === 'ok') state.briefing.done = true;
          else state.briefing = null;
        }
      }
      if (plan.doInApp) {
        if (inAppOutcome === 'ok') rec.inApp = true;
        else delete rec.inApp;
      }
      await saveState(user.id, state, nowMs);
    });
  }
  if (error) throw error;

  let reason = plan.pushReason;
  if (!reason && plan.doPush && pushOutcome === 'rejected') {
    reason = 'The phone did not accept the push, for example because there is no device token.';
  } else if (!reason && !pushed && plan.busy) {
    reason = 'Another worker is already delivering this briefing.';
  }
  return out(pushed, stored, reason, reason ? plan.pushResume : null);
}

function nextDayParts(ms, tz) {
  const p = localParts(ms, tz);
  return [p.year, p.month, p.day + 1];
}
