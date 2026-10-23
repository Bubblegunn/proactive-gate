import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Morning briefing window, in the user's local time.
const WAKE_HOUR = 7; // earliest local time a briefing goes out
const END_HOUR = 10; // after this the briefing is stale and waits for the next day

// Dismissal fatigue: this many swipes of one type inside the period stops pushes of that type.
const DISMISS_LIMIT = 3;
const DISMISS_PERIOD_MS = 7 * 24 * 3600 * 1000;

const LOCK_STALE_MS = 60_000;
const KEEP_DELIVERIES_MS = 3 * 24 * 3600 * 1000;


// ---------- time helpers ----------

function toDate(value) {
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(d.getTime())) throw new TypeError('invalid time value');
  return d;
}

function validTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function localParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute') };
}

function offsetMs(date, tz) {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
  return asUtc - Math.floor(date.getTime() / 60000) * 60000;
}

// UTC instant of a local wall-clock time (day overflow is normalised by Date.UTC).
function zonedToUtc(y, m, d, h, min, tz) {
  const naive = Date.UTC(y, m - 1, d, h, min);
  let guess = naive - offsetMs(new Date(naive), tz);
  guess = naive - offsetMs(new Date(guess), tz);
  return new Date(guess);
}

function localDateKey(date, tz) {
  const p = localParts(date, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

// First moment at or after `t` that is inside the local briefing window,
// skipping any local date in `blockedDates`.
function nextBriefingSlot(t, tz, blockedDates) {
  let cursor = t;
  for (let i = 0; i < 14; i++) {
    const p = localParts(cursor, tz);
    const key = localDateKey(cursor, tz);
    const open = zonedToUtc(p.y, p.m, p.d, WAKE_HOUR, 0, tz);
    const close = zonedToUtc(p.y, p.m, p.d, END_HOUR, 0, tz);
    if (!blockedDates.has(key)) {
      if (cursor < open) return open;
      if (cursor < close) return cursor;
    }
    cursor = zonedToUtc(p.y, p.m, p.d + 1, WAKE_HOUR, 0, tz);
  }
  return null;
}

// ---------- shared state (one JSON file per user, guarded by a lock directory) ----------

async function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withUserState(userId, fn) {
  const dir = await stateDir();
  const base = path.join(dir, `user-${crypto.createHash('sha256').update(String(userId)).digest('hex')}`);
  const lock = `${base}.lock`;
  for (;;) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) await fs.rmdir(lock).catch(() => {});
      } catch { /* lock vanished, retry */ }
      await sleep(5 + Math.random() * 20);
    }
  }
  try {
    let state = { dismissals: {}, deliveries: {} };
    try {
      state = { ...state, ...JSON.parse(await fs.readFile(`${base}.json`, 'utf8')) };
    } catch (err) {
      if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
    }
    const save = async () => {
      const tmp = `${base}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(state));
      await fs.rename(tmp, `${base}.json`);
    };
    return await fn(state, save);
  } finally {
    await fs.rmdir(lock).catch(() => {});
  }
}

export async function recordDismissal(userId, type, now) {
  const t = toDate(now ?? Date.now()).getTime();
  await withUserState(userId, async (state, save) => {
    const list = (state.dismissals[type] ??= []);
    list.push(t);
    state.dismissals[type] = list.filter((x) => x > t - DISMISS_PERIOD_MS).sort((a, b) => a - b);
    await save();
  });
}

// ---------- delivery ----------

function result(push, inApp, reason, resumeAt) {
  return { push, inApp, reason: reason ?? null, resumeAt: resumeAt ? resumeAt.toISOString() : null };
}

export async function deliver({ user, candidate, now, transport, consentStore }) {
  const nowDate = toDate(now ?? Date.now());
  const type = candidate.type;
  const isBriefing = type === 'briefing';

  // 1. The user switched this kind off, or was never asked (no explicit yes, so no push).
  const choice = user.categories ? user.categories[type] : undefined;
  if (choice === false) {
    return result(false, false, `The user turned off ${type} notifications.`, null);
  }
  let pushAllowed = choice === true;
  let pushNote = pushAllowed ? null : `The user has not opted in to ${type} notifications, so no push was sent.`;

  // 2. Consent. Fail closed when the store cannot answer.
  let consents;
  try {
    consents = await consentStore.get(user.id);
  } catch {
    return result(false, false, 'Consent could not be checked right now, so nothing was sent.', null);
  }
  if (!consents || [type, 'push', 'notifications'].some((k) => consents[k] === false)) {
    return result(false, false, 'The user has not given consent for these notifications.', null);
  }

  // 3. Snooze.
  let earliest = nowDate;
  if (user.snoozedUntil != null) {
    const until = new Date(user.snoozedUntil);
    if (Number.isNaN(until.getTime())) {
      return result(false, false, 'The snooze setting could not be read, so nothing was sent.', null);
    }
    if (until > nowDate) {
      earliest = until;
      if (!isBriefing) {
        return result(false, false, 'Notifications are snoozed.', until);
      }
    }
  }

  // 4. Briefing timing, in the user's local time. Other cards have no wake window.
  let tz = null;
  if (isBriefing) {
    if (!validTimezone(user.timezone)) {
      return result(false, false, 'The time zone is unknown, so the local morning could not be worked out.', null);
    }
    tz = user.timezone;
  }

  return withUserState(user.id, async (state, save) => {
    for (const [id, rec] of Object.entries(state.deliveries)) {
      if (rec.at < nowDate.getTime() - KEEP_DELIVERIES_MS) delete state.deliveries[id];
    }

    // 5. Same candidate already (partly) delivered: only send what is missing.
    const done = state.deliveries[candidate.id] ?? { push: false, inApp: false, at: nowDate.getTime(), date: null };

    if (isBriefing) {
      const blocked = new Set();
      for (const [id, rec] of Object.entries(state.deliveries)) {
        if (id !== candidate.id && rec.kind === 'briefing' && (rec.push || rec.inApp) && rec.tz === tz) {
          blocked.add(rec.date);
        }
      }
      const slot = nextBriefingSlot(earliest, tz, blocked);
      if (!done.push && !done.inApp) {
        if (!slot || slot.getTime() > nowDate.getTime()) {
          const why = earliest > nowDate ? 'Notifications are snoozed.'
            : blocked.has(localDateKey(nowDate, tz)) ? 'Today\'s briefing was already sent.'
            : 'It is outside the morning briefing hours (07:00 to 10:00 local time).';
          return result(false, false, why, slot);
        }
      }
    }

    // 6. Dismissal fatigue: too many recent swipes stop pushes, the quiet in-app item still goes out.
    const recent = (state.dismissals[type] ?? []).filter((x) => x > nowDate.getTime() - DISMISS_PERIOD_MS);
    let fatigueResume = null;
    if (recent.length >= DISMISS_LIMIT) {
      pushAllowed = false;
      fatigueResume = new Date(recent[recent.length - DISMISS_LIMIT] + DISMISS_PERIOD_MS);
      pushNote = `The user dismissed ${type} cards ${recent.length} times recently, so no push was sent.`;
    }

    // 7. OS permission only affects the phone push.
    if (user.notificationsPermitted === false) {
      pushAllowed = false;
      pushNote = 'Notifications are switched off in the phone settings, so no push was sent.';
      fatigueResume = null;
    }

    const record = () => {
      state.deliveries[candidate.id] = {
        ...done, kind: type, tz, at: done.at, date: tz ? localDateKey(nowDate, tz) : null,
      };
      return save();
    };

    let pushed = done.push;
    let stored = done.inApp;
    let reason = null;

    if (!pushed && pushAllowed) {
      let ok = false;
      try {
        ok = (await transport.push(user, candidate)) === true;
      } catch {
        ok = false;
      }
      if (ok) {
        pushed = true;
        done.push = true;
        await record();
      } else {
        pushNote = 'The phone did not accept the push (for example no device token).';
        fatigueResume = null;
      }
    }

    if (!stored) {
      await transport.inApp(user, candidate);
      stored = true;
      done.inApp = true;
      await record();
    }

    if (!pushed) reason = `${pushNote ?? 'No push was sent.'} The in-app item was stored.`;
    return result(pushed, stored, reason, !pushed ? fatigueResume : null);
  });
}
