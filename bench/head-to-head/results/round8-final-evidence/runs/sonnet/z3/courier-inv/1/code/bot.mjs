import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Morning briefing push goes out between 07:00 and 11:00 in the user's own time zone.
const WINDOW_OPEN_MIN = 7 * 60;
const WINDOW_CLOSE_MIN = 11 * 60;
// A user who swiped away DISMISS_LIMIT cards of one type within DISMISS_DAYS gets no more pushes of that type.
const DISMISS_LIMIT = 3;
const DISMISS_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 60_000;
const LOCK_TIMEOUT_MS = 30_000;

const toDate = (v) => {
  const d = v instanceof Date ? new Date(v.getTime()) : new Date(v);
  if (Number.isNaN(d.getTime())) throw new TypeError('invalid date');
  return d;
};

// ---------- time zone helpers ----------

const formatters = new Map();
function localParts(ms, tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  const p = {};
  for (const { type, value } of f.formatToParts(new Date(ms))) p[type] = Number(value);
  return p; // year, month, day, hour, minute, second
}

function tzOffset(ms, tz) {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

function localToUtc(y, mo, d, minutes, tz) {
  const guess = Date.UTC(y, mo - 1, d, 0, minutes);
  let t = guess - tzOffset(guess, tz);
  const off2 = tzOffset(t, tz);
  t = guess - off2;
  return t;
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

/** Earliest instant >= ms that lies inside the user's daily send window. */
function nextWindowTime(ms, tz) {
  const p = localParts(ms, tz);
  const min = p.hour * 60 + p.minute;
  if (min >= WINDOW_OPEN_MIN && min < WINDOW_CLOSE_MIN) return ms;
  const dayOffset = min < WINDOW_OPEN_MIN ? 0 : 1;
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day + dayOffset));
  return localToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), WINDOW_OPEN_MIN, tz);
}

function localDay(ms, tz) {
  const p = localParts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// ---------- shared state (one file per user, guarded by a lock directory) ----------

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withUserState(userId, fn) {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const key = createHash('sha256').update(String(userId)).digest('hex').slice(0, 40);
  const file = path.join(dir, `user-${key}.json`);
  const lock = `${file}.lock`;
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const s = await stat(lock);
        if (Date.now() - s.mtimeMs > LOCK_STALE_MS) await rmdir(lock).catch(() => {});
      } catch { /* lock vanished, retry */ }
      if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error('could not lock user state');
      await sleep(5 + Math.random() * 25);
    }
  }
  try {
    let state = { sent: {}, days: {}, dismissals: {} };
    try {
      state = { ...state, ...JSON.parse(await readFile(file, 'utf8')) };
    } catch (e) {
      if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
    }
    const result = await fn(state);
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, JSON.stringify(state));
    await rename(tmp, file);
    return result;
  } finally {
    await rmdir(lock).catch(() => {});
  }
}

// ---------- public API ----------

export async function recordDismissal(userId, type, now) {
  const t = toDate(now ?? new Date()).getTime();
  await withUserState(userId, async (state) => {
    const list = (state.dismissals[type] ?? []).filter((x) => t - x < DISMISS_DAYS * DAY_MS);
    list.push(t);
    list.sort((a, b) => a - b);
    state.dismissals[type] = list.slice(-20);
  });
}

export async function deliver({ user, candidate, now, transport, consentStore }) {
  const nowMs = toDate(now ?? new Date()).getTime();
  const type = candidate.type;
  const out = { push: false, inApp: false, reason: null, resumeAt: null };
  const iso = (ms) => new Date(ms).toISOString();

  const tzOk = validTimezone(user.timezone);

  // Snooze and a switched-off category stop everything, including the in-app item.
  if (user.categories && user.categories[type] === false) {
    out.reason = `The user switched off ${type} notifications.`;
    return out;
  }
  if (user.snoozedUntil != null) {
    const until = Date.parse(user.snoozedUntil);
    if (Number.isNaN(until)) {
      out.reason = 'The snooze setting could not be read, so nothing was sent.';
      return out;
    }
    if (until > nowMs) {
      out.reason = 'The user snoozed notifications.';
      out.resumeAt = iso(tzOk && type === 'briefing' ? nextWindowTime(until, user.timezone) : until);
      return out;
    }
  }

  return withUserState(user.id, async (state) => {
    const prior = state.sent[candidate.id] ?? { push: false, inApp: false };
    const reasons = [];

    // Reasons the push specifically is withheld, plus when it could go out.
    let pushBlock = null;
    let pushResume = null;
    const block = (reason, resume = null) => {
      if (pushBlock) return;
      pushBlock = reason;
      pushResume = resume;
    };

    if (user.categories?.[type] !== true) {
      block(`The user has not chosen to receive ${type} push notifications.`);
    }
    if (!pushBlock && user.notificationsPermitted === false) {
      block('Notifications are turned off for the app in the phone settings.');
    }
    if (!pushBlock && type === 'briefing') {
      if (!tzOk) {
        block('The time zone is unknown, so the morning time could not be checked.');
      } else {
        const p = localParts(nowMs, user.timezone);
        const min = p.hour * 60 + p.minute;
        if (min < WINDOW_OPEN_MIN || min >= WINDOW_CLOSE_MIN) {
          block('It is outside the morning window for the user.', nextWindowTime(nowMs, user.timezone));
        }
      }
    }
    if (!pushBlock) {
      const recent = (state.dismissals[type] ?? []).filter((x) => nowMs - x < DISMISS_DAYS * DAY_MS);
      if (recent.length >= DISMISS_LIMIT) {
        const free = recent[recent.length - DISMISS_LIMIT] + DISMISS_DAYS * DAY_MS;
        block(`The user dismissed the last ${recent.length} ${type} cards, so push is paused.`,
          tzOk && type === 'briefing' ? nextWindowTime(free, user.timezone) : free);
      }
    }
    if (!pushBlock && type === 'briefing' && tzOk && !prior.push) {
      if (state.days[`${type}:${localDay(nowMs, user.timezone)}`]) {
        block('A morning briefing push was already sent today.');
      }
    }
    if (!pushBlock && !prior.push) {
      let consents = null;
      try {
        consents = await consentStore.get(user.id);
      } catch {
        consents = null;
      }
      if (!consents || typeof consents !== 'object') {
        block('Consent could not be checked, so no push was sent.');
      } else if (consents.push === false || consents[type] === false) {
        block('The user has not consented to push notifications.');
      }
    }

    // In-app item: stored once per candidate.
    if (prior.inApp) {
      out.inApp = true;
    } else {
      try {
        await transport.inApp(user, candidate);
        out.inApp = true;
        prior.inApp = true;
      } catch {
        reasons.push('The in-app item could not be stored.');
      }
    }

    // Push: sent once per candidate.
    if (prior.push) {
      out.push = true;
    } else if (!pushBlock) {
      let accepted = false;
      try {
        accepted = (await transport.push(user, candidate)) === true;
      } catch {
        accepted = false;
      }
      if (accepted) {
        out.push = true;
        prior.push = true;
        if (type === 'briefing' && tzOk) state.days[`${type}:${localDay(nowMs, user.timezone)}`] = candidate.id;
      } else {
        reasons.push('The phone did not accept the push, so it is only in the app.');
      }
    } else {
      reasons.unshift(pushBlock);
      if (pushResume != null) out.resumeAt = iso(pushResume);
    }

    if (prior.push || prior.inApp) {
      state.sent[candidate.id] = prior;
      // keep the file small: drop the oldest candidates and old day markers
      const ids = Object.keys(state.sent);
      if (ids.length > 200) for (const id of ids.slice(0, ids.length - 200)) delete state.sent[id];
      const dayKeys = Object.keys(state.days);
      if (dayKeys.length > 60) for (const k of dayKeys.slice(0, dayKeys.length - 60)) delete state.days[k];
    }

    out.reason = reasons.length ? reasons.join(' ') : null;
    return out;
  });
}
