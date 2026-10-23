import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Briefing goes out between WAKE_HOUR (inclusive) and WINDOW_END_HOUR (exclusive), user's local time.
const WAKE_HOUR = 7;
const WINDOW_END_HOUR = 11;
// Other push types are held during quiet hours (QUIET_START_HOUR to WAKE_HOUR).
const QUIET_START_HOUR = 22;
// Dismissal fatigue: this many dismissals of one type inside the window stops push for that type.
const DISMISS_LIMIT = 3;
const DISMISS_WINDOW_MS = 7 * 24 * 3600 * 1000;
const KEEP_MS = 90 * 24 * 3600 * 1000;
const PENDING_MS = 2 * 60 * 1000;
const LOCK_STALE_MS = 10 * 1000;

// ---------- time helpers ----------

function toDate(v) {
  const d = v instanceof Date ? new Date(v.getTime()) : new Date(v);
  if (Number.isNaN(d.getTime())) throw new TypeError('invalid date: ' + String(v));
  return d;
}

function validZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function localParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  const o = {};
  for (const p of f.formatToParts(date)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o;
}

function offsetMs(ms, tz) {
  const p = localParts(new Date(ms), tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

// Local wall-clock (y, m, d, hour:00) in tz -> UTC ms. Day overflow is normalised by Date.UTC.
function zonedToUtcMs(y, m, d, hour, tz) {
  const wall = Date.UTC(y, m - 1, d, hour, 0, 0);
  let guess = wall - offsetMs(wall, tz);
  guess = wall - offsetMs(guess, tz);
  return guess;
}

function localDateKey(date, tz) {
  const p = localParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// First instant >= date at which local time is `hour`:00, today or tomorrow.
function nextLocalHour(date, tz, hour) {
  const p = localParts(date, tz);
  const today = zonedToUtcMs(p.year, p.month, p.day, hour, tz);
  if (today >= date.getTime()) return today;
  return zonedToUtcMs(p.year, p.month, p.day + 1, hour, tz);
}

function inWindow(date, tz) {
  const h = localParts(date, tz).hour;
  return h >= WAKE_HOUR && h < WINDOW_END_HOUR;
}

function inQuiet(date, tz) {
  const h = localParts(date, tz).hour;
  return h >= QUIET_START_HOUR || h < WAKE_HOUR;
}

// ---------- shared state (one JSON file per user, cross-process lock) ----------

async function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withUserState(userId, fn) {
  const dir = await stateDir();
  const key = crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 32);
  const file = path.join(dir, `user-${key}.json`);
  const lock = file + '.lock';
  const started = Date.now();
  for (;;) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fs.rmdir(lock).catch(() => {});
          continue;
        }
      } catch { /* lock vanished, retry */ }
      if (Date.now() - started > 30000) throw new Error('could not lock state for user');
      await sleep(5 + Math.random() * 20);
    }
  }
  try {
    let state = { dismissals: {}, sent: {} };
    try {
      state = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
    }
    state.dismissals ||= {};
    state.sent ||= {};
    const result = await fn(state);
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state));
    await fs.rename(tmp, file);
    return result;
  } finally {
    await fs.rmdir(lock).catch(() => {});
  }
}

function prune(state, nowMs) {
  for (const [k, v] of Object.entries(state.sent)) {
    if (nowMs - Date.parse(v.at) > KEEP_MS) delete state.sent[k];
  }
  for (const [t, list] of Object.entries(state.dismissals)) {
    state.dismissals[t] = list.filter((iso) => nowMs - Date.parse(iso) <= KEEP_MS);
    if (!state.dismissals[t].length) delete state.dismissals[t];
  }
}

// ---------- public API ----------

export async function recordDismissal(userId, type, now) {
  const at = toDate(now === undefined ? new Date() : now);
  await withUserState(userId, (state) => {
    (state.dismissals[type] ||= []).push(at.toISOString());
    prune(state, at.getTime());
  });
}

function dismissalHold(state, type, nowMs) {
  const recent = (state.dismissals[type] || [])
    .map((iso) => Date.parse(iso))
    .filter((t) => t <= nowMs && nowMs - t < DISMISS_WINDOW_MS)
    .sort((a, b) => b - a);
  if (recent.length < DISMISS_LIMIT) return null;
  return recent[DISMISS_LIMIT - 1] + DISMISS_WINDOW_MS;
}

export async function deliver({ user, candidate, now, transport, consentStore }) {
  const nowDate = toDate(now);
  const nowMs = nowDate.getTime();
  const type = candidate.type;
  const isBriefing = type === 'briefing';
  const out = (push, inApp, reason, resume) => ({
    push, inApp, reason: reason ?? null,
    resumeAt: resume == null ? null : new Date(resume).toISOString(),
  });

  // 1. Category switched off by the user: nothing goes out, no resume time.
  if (user.categories && user.categories[type] === false) {
    return out(false, false, `The user switched off ${type} notifications.`, null);
  }

  // 2. Local time is needed for the briefing window and quiet hours.
  const tzOk = validZone(user.timezone);
  if (!tzOk && isBriefing) {
    return out(false, false, 'The user timezone is missing or invalid, so the wake-up time is unknown.', null);
  }

  // 3. Snooze and briefing window gate the whole delivery.
  let resume = nowMs;
  const reasons = [];
  if (user.snoozedUntil != null) {
    const snoozeMs = Date.parse(user.snoozedUntil);
    if (Number.isNaN(snoozeMs)) {
      return out(false, false, 'The snooze time is not a valid date.', null);
    }
    if (snoozeMs > nowMs) {
      resume = snoozeMs;
      reasons.push('The user snoozed notifications');
    }
  }
  if (isBriefing) {
    // Move forward until the instant is outside the snooze and inside the wake window.
    for (let i = 0; i < 4 && !inWindow(new Date(resume), user.timezone); i++) {
      resume = nextLocalHour(new Date(resume), user.timezone, WAKE_HOUR);
      if (!inWindow(new Date(resume), user.timezone)) resume += 1; // exact-boundary safety
    }
    if (resume > nowMs && !reasons.length) reasons.push('It is outside the morning briefing time window');
  }
  if (resume > nowMs) {
    return out(false, false, reasons[0] + ` until ${new Date(resume).toISOString()}.`, resume);
  }

  // 4. Claim the send so concurrent workers and retries do not deliver twice.
  const dayKey = tzOk ? localDateKey(nowDate, user.timezone) : nowDate.toISOString().slice(0, 10);
  const sentKey = isBriefing ? `briefing:${dayKey}` : `card:${type}:${candidate.id}`;
  const claim = await withUserState(user.id, (state) => {
    prune(state, nowMs);
    const prev = state.sent[sentKey];
    if (prev) {
      const pending = prev.pending && nowMs - Date.parse(prev.at) < PENDING_MS;
      if (!prev.pending || pending) return { dup: prev };
    }
    state.sent[sentKey] = { at: nowDate.toISOString(), pending: true, push: false, inApp: false };
    return { hold: dismissalHold(state, type, nowMs) };
  });
  if (claim.dup) {
    return out(false, false, 'This notification was already sent (or is being sent) for this user.', null);
  }

  // 5. Decide push eligibility.
  let pushReason = null;
  let pushResume = null;
  let tryPush = true;
  if (user.notificationsPermitted === false) {
    tryPush = false;
    pushReason = 'Phone notifications are turned off in the operating system settings.';
  } else if (!isBriefing && tzOk && inQuiet(nowDate, user.timezone)) {
    tryPush = false;
    pushResume = nextLocalHour(nowDate, user.timezone, WAKE_HOUR);
    pushReason = 'Push is held during quiet hours.';
  } else if (claim.hold != null) {
    tryPush = false;
    pushResume = claim.hold;
    pushReason = `The user dismissed ${type} cards several times recently, so push is paused.`;
  } else if (!user.categories || user.categories[type] !== true) {
    tryPush = false;
    pushReason = `The user has not opted in to ${type} push notifications.`;
  }
  if (tryPush) {
    try {
      const consents = await consentStore.get(user.id);
      const c = consents && (consents.push ?? consents.notifications);
      if (c !== true) {
        tryPush = false;
        pushReason = 'The user has not given consent for push notifications.';
      }
    } catch {
      tryPush = false;
      pushReason = 'Consent could not be checked, so push was not sent.';
    }
  }

  // 6. Send.
  let push = false;
  let inApp = false;
  if (tryPush) {
    try {
      push = (await transport.push(user, candidate)) === true;
    } catch {
      push = false;
    }
    if (!push) pushReason = 'The phone did not accept the push (for example no device token).';
  }
  try {
    await transport.inApp(user, candidate);
    inApp = true;
  } catch {
    inApp = false;
  }

  // 7. Record result; release the claim when nothing was delivered so a retry can work.
  await withUserState(user.id, (state) => {
    if (push || inApp) {
      state.sent[sentKey] = { at: nowDate.toISOString(), push, inApp };
    } else {
      delete state.sent[sentKey];
    }
  });

  let reason = null;
  if (!inApp) reason = 'The in-app item could not be stored.' + (pushReason ? ' ' + pushReason : '');
  else if (!push) reason = pushReason;
  return out(push, inApp, reason, push ? null : pushResume);
}
