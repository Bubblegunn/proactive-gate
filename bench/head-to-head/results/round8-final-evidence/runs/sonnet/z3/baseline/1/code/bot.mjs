import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Local-time rules. Pushes go out from 08:00 (wake time) to 21:00 local;
// the morning briefing only until 11:00 local.
const WAKE_MIN = 8 * 60;
const DAY_END_MIN = 21 * 60;
const BRIEFING_END_MIN = 11 * 60;

// Dismissal back-off: 3 swipes of one card type within 14 days pauses that type for 7 days.
const DISMISS_LIMIT = 3;
const DISMISS_WINDOW_MS = 14 * 86400e3;
const DISMISS_PAUSE_MS = 7 * 86400e3;

const INFLIGHT_STALE_MS = 60e3;
const LOCK_STALE_MS = 15e3;
const LOCK_WAIT_MS = 10e3;
const KEEP_SENT_MS = 30 * 86400e3;

// ---------- time helpers ----------

const formatters = new Map();
function localParts(date, tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(tz, f);
  }
  const p = {};
  for (const { type, value } of f.formatToParts(date)) p[type] = Number(value);
  return p;
}

function offsetMs(ms, tz) {
  const p = localParts(new Date(ms), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

function zonedToUtc(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const o1 = offsetMs(guess, tz);
  let t = guess - o1;
  const o2 = offsetMs(t, tz);
  if (o2 !== o1) t = guess - o2;
  return new Date(t);
}

function dayKey(date, tz) {
  const p = localParts(date, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

function windowEnd(type) {
  return type === 'briefing' ? BRIEFING_END_MIN : DAY_END_MIN;
}

// Earliest instant >= t at which a push of this type may go out.
function nextAllowed(t, tz, type) {
  const p = localParts(t, tz);
  const minutes = p.hour * 60 + p.minute;
  if (minutes >= WAKE_MIN && minutes < windowEnd(type)) return t;
  const dayOffset = minutes < WAKE_MIN ? 0 : 1;
  return zonedToUtc(p.year, p.month, p.day + dayOffset, 8, 0, tz);
}

function toDate(v) {
  const d = v instanceof Date ? v : new Date(v ?? Date.now());
  if (Number.isNaN(d.getTime())) throw new TypeError('invalid time value');
  return d;
}

// ---------- shared state (one JSON file per user, guarded by a lock directory) ----------

async function stateFile(userId) {
  const dir = path.resolve(process.env.STATE_DIR || path.join(process.cwd(), '.state'));
  await fs.mkdir(dir, { recursive: true });
  const name = crypto.createHash('sha256').update(String(userId)).digest('hex');
  return path.join(dir, `${name}.json`);
}

async function withLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          const grave = `${lock}.${process.pid}.${crypto.randomUUID()}`;
          await fs.rename(lock, grave);
          await fs.rm(grave, { recursive: true, force: true });
          continue;
        }
      } catch { /* lock vanished or was taken over; retry */ }
      if (Date.now() > deadline) throw new Error('state lock timeout');
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 30));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

async function load(file) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { sent: {}, briefingDay: null, dismissals: {} };
    throw e;
  }
  const st = JSON.parse(text);
  st.sent ??= {};
  st.dismissals ??= {};
  st.briefingDay ??= null;
  return st;
}

async function save(file, st) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(st));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
}

// ---------- public API ----------

export async function recordDismissal(userId, type, now) {
  const at = toDate(now).getTime();
  const file = await stateFile(userId);
  await withLock(file, async () => {
    const st = await load(file);
    const list = (st.dismissals[type] ??= []);
    list.push(at);
    const newest = Math.max(...list);
    st.dismissals[type] = list.filter((t) => t > newest - DISMISS_WINDOW_MS).sort((a, b) => a - b);
    await save(file, st);
  });
}

function dismissalPauseEnd(st, type, nowMs) {
  const recent = (st.dismissals[type] || []).filter((t) => t <= nowMs && t > nowMs - DISMISS_WINDOW_MS);
  if (recent.length < DISMISS_LIMIT) return 0;
  return Math.max(...recent) + DISMISS_PAUSE_MS;
}

const none = (reason, resumeAt = null) => ({ push: false, inApp: false, reason, resumeAt });

export async function deliver({ user, candidate, now, transport, consentStore }) {
  try {
    return await run({ user, candidate, now, transport, consentStore });
  } catch (e) {
    return none(`Nothing was sent because of an internal error: ${e?.message ?? e}.`);
  }
}

async function run({ user, candidate, now, transport, consentStore }) {
  const nowDate = toDate(now);
  const nowMs = nowDate.getTime();
  const type = candidate.type;
  const tz = user.timezone;

  // 1. The user's own choice per notification category. Missing means never asked, so no consent.
  if (user.categories?.[type] !== true) {
    const asked = user.categories && type in user.categories;
    return none(asked
      ? `The user turned off ${type} notifications.`
      : `The user has not been asked about ${type} notifications yet.`);
  }

  let tzOk = true;
  try { localParts(nowDate, tz); } catch { tzOk = false; }

  const file = await stateFile(user.id);

  // 2. Snooze and dismissal pause (both surfaces wait).
  let holdUntil = 0;
  let holdReason = null;
  if (user.snoozedUntil != null) {
    const s = new Date(user.snoozedUntil).getTime();
    if (Number.isNaN(s)) return none('The snooze setting could not be read, so nothing was sent.');
    if (s > nowMs) {
      holdUntil = s;
      holdReason = `The user snoozed ${type} notifications until ${new Date(s).toISOString()}.`;
    }
  }
  const stPeek = await load(file);
  const pauseEnd = dismissalPauseEnd(stPeek, type, nowMs);
  if (pauseEnd > nowMs && pauseEnd > holdUntil) {
    holdUntil = pauseEnd;
    holdReason = `The user dismissed ${type} cards several times, so they are paused until ${new Date(pauseEnd).toISOString()}.`;
  }
  if (holdUntil > nowMs) {
    const resume = tzOk ? nextAllowed(new Date(holdUntil), tz, type) : new Date(holdUntil);
    return none(holdReason, resume.toISOString());
  }

  // 3. Time of day in the user's timezone.
  let pushAllowed = true;
  const softReasons = [];
  if (!tzOk) {
    pushAllowed = false;
    softReasons.push('The user timezone is not valid, so the push was not sent.');
  } else {
    const allowedAt = nextAllowed(nowDate, tz, type);
    if (allowedAt.getTime() !== nowMs) {
      return none(type === 'briefing'
        ? 'It is outside the morning window in the user local time.'
        : 'It is quiet hours in the user local time.', allowedAt.toISOString());
    }
  }

  // 4. Push consent and operating system permission (in-app is still allowed).
  if (pushAllowed) {
    try {
      const consents = await consentStore.get(user.id);
      const blocked = !consents || typeof consents !== 'object'
        || [consents.push, consents.notifications, consents[type]].some((v) => v === false);
      if (blocked) {
        pushAllowed = false;
        softReasons.push('The user has not consented to push notifications.');
      }
    } catch {
      pushAllowed = false;
      softReasons.push('Push consent could not be checked, so the push was not sent.');
    }
  }
  if (pushAllowed && user.notificationsPermitted === false) {
    pushAllowed = false;
    softReasons.push('Notifications are turned off for the app in the phone settings.');
  }

  // 5. Claim the work under the lock (dedupe by candidate, one briefing per local day).
  const claim = await withLock(file, async () => {
    const st = await load(file);
    const t = Date.now();
    for (const [id, r] of Object.entries(st.sent)) if (t - (r.at ?? 0) > KEEP_SENT_MS) delete st.sent[id];
    const rec = (st.sent[candidate.id] ??= { push: false, inApp: false, at: t });
    if (rec.inflight && t - rec.inflight < INFLIGHT_STALE_MS) return { busy: true };
    if (rec.pushPending) { rec.pushUnknown = true; rec.pushPending = false; } // crashed mid-push: never repeat it
    const day = tzOk ? dayKey(nowDate, tz) : null;
    if (type === 'briefing' && day && st.briefingDay?.day === day && st.briefingDay.id !== candidate.id) {
      if (!rec.push && !rec.inApp) delete st.sent[candidate.id];
      const next = zonedToUtc(...(() => { const p = localParts(nowDate, tz); return [p.year, p.month, p.day + 1, 8, 0]; })(), tz);
      return { capped: next.toISOString() };
    }
    const wantPush = pushAllowed && !rec.push && !rec.pushUnknown;
    const wantInApp = !rec.inApp;
    if (!wantPush && !wantInApp) return { replay: { push: rec.push, inApp: rec.inApp } };
    rec.inflight = t;
    rec.at = t;
    if (type === 'briefing' && day) st.briefingDay = { day, id: candidate.id };
    if (wantPush) rec.pushPending = true;
    await save(file, st);
    return { wantPush, wantInApp, prior: { push: rec.push, inApp: rec.inApp } };
  });

  if (claim.busy) return none('Another worker is delivering this item right now.');
  if (claim.capped) return none('The morning briefing was already sent today.', claim.capped);
  if (claim.replay) {
    return { ...claim.replay, reason: 'Already delivered earlier.', resumeAt: null };
  }

  // 6. Send (outside the lock).
  let pushOk = false;
  let inAppOk = false;
  if (claim.wantPush) {
    try {
      pushOk = (await transport.push(user, candidate)) === true;
      if (!pushOk) softReasons.push('The phone did not accept the push, for example because it has no device token.');
    } catch {
      softReasons.push('The push could not be sent.');
    }
  }
  if (claim.wantInApp) {
    try {
      await transport.inApp(user, candidate);
      inAppOk = true;
    } catch {
      softReasons.push('The in-app item could not be stored.');
    }
  }

  // 7. Record the outcome.
  await withLock(file, async () => {
    const st = await load(file);
    const rec = (st.sent[candidate.id] ??= { push: false, inApp: false });
    if (claim.wantPush) { rec.pushPending = false; if (pushOk) rec.push = true; }
    if (inAppOk) rec.inApp = true;
    delete rec.inflight;
    rec.at = Date.now();
    // Nothing went out: free the day's briefing slot so a retry or another candidate can use it.
    if (!rec.push && !rec.inApp && !rec.pushUnknown && st.briefingDay?.id === candidate.id) st.briefingDay = null;
    await save(file, st);
  });

  const push = pushOk || claim.prior.push;
  const inApp = inAppOk || claim.prior.inApp;
  return { push, inApp, reason: softReasons.length ? softReasons.join(' ') : null, resumeAt: null };
}
