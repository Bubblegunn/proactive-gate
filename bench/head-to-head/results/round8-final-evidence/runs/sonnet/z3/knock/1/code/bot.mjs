import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Policy constants
const WINDOW_START_HOUR = 7; // people wake up: nothing goes out before this local hour
const BRIEFING_END_HOUR = 11; // a morning briefing is stale after this local hour
const QUIET_START_HOUR = 22; // other card types: no push from this local hour until WINDOW_START_HOUR
const DISMISS_LIMIT = 3; // this many swipes of one type ...
const DISMISS_WINDOW_MS = 14 * 24 * 3600 * 1000; // ... within this time stops push for that type
const SENT_KEEP_MS = 3 * 24 * 3600 * 1000;
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 30_000;

// ---------- time helpers ----------

const formatters = new Map();
function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

function localParts(ms, tz) {
  const p = {};
  for (const { type, value } of formatter(tz).formatToParts(new Date(ms))) p[type] = Number(value);
  return { y: p.year, m: p.month, d: p.day, h: p.hour % 24 };
}

function offsetAt(ms, tz) {
  const p = {};
  for (const { type, value } of formatter(tz).formatToParts(new Date(Math.floor(ms / 1000) * 1000))) p[type] = Number(value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// UTC ms of local wall-clock hour `h` on local date y-m-d (d may overflow; Date.UTC normalises it).
function atLocal(tz, y, m, d, h) {
  const guess = Date.UTC(y, m - 1, d, h);
  let t = guess - offsetAt(guess, tz);
  t = guess - offsetAt(t, tz);
  return t;
}

function validTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { formatter(tz); return true; } catch { return false; }
}

function isAllowedHour(h, type) {
  if (type === 'briefing') return h >= WINDOW_START_HOUR && h < BRIEFING_END_HOUR;
  return h >= WINDOW_START_HOUR && h < QUIET_START_HOUR;
}

// Earliest instant >= ms at which this card type may go out in the user's local day.
function nextAllowed(ms, tz, type) {
  const { y, m, d, h } = localParts(ms, tz);
  if (isAllowedHour(h, type)) return ms;
  if (h < WINDOW_START_HOUR) return atLocal(tz, y, m, d, WINDOW_START_HOUR);
  return atLocal(tz, y, m, d + 1, WINDOW_START_HOUR);
}

function localDay(ms, tz) {
  const { y, m, d } = localParts(ms, tz);
  return `${y}-${m}-${d}`;
}

function parseTime(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Date.parse(v);
  return NaN;
}

const iso = (ms) => new Date(ms).toISOString();

// ---------- shared state (one file + one lock per user, safe across processes) ----------

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function userKey(userId) {
  return crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 40);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquireLock(lockDir) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await fs.mkdir(lockDir);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    try {
      const st = await fs.stat(lockDir);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        // owner died; move the dead lock aside (only one racer wins the rename)
        const aside = `${lockDir}.stale-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        await fs.rename(lockDir, aside).then(() => fs.rm(aside, { recursive: true, force: true }), () => {});
        continue;
      }
    } catch { /* lock vanished, retry */ }
    if (Date.now() > deadline) throw new Error('could not get the user state lock');
    await sleep(15 + Math.random() * 35);
  }
}

async function withUserState(userId, fn) {
  const dir = stateDir();
  await fs.mkdir(dir, { recursive: true });
  const key = userKey(userId);
  const file = path.join(dir, `user-${key}.json`);
  const lockDir = path.join(dir, `user-${key}.lock`);
  await acquireLock(lockDir);
  const beat = setInterval(() => {
    const t = new Date();
    fs.utimes(lockDir, t, t).catch(() => {});
  }, LOCK_STALE_MS / 4);
  try {
    let state = { sent: {}, dismissals: {} };
    try {
      state = { ...state, ...JSON.parse(await fs.readFile(file, 'utf8')) };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // corrupt state: refuse to guess
    }
    const result = await fn(state);
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const fh = await fs.open(tmp, 'w');
    try {
      await fh.writeFile(JSON.stringify(state));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, file);
    return result;
  } finally {
    clearInterval(beat);
    await fs.rm(lockDir, { recursive: true, force: true });
  }
}

// ---------- public API ----------

const withheld = (reason, resumeAtMs = null) => ({
  push: false,
  inApp: false,
  reason,
  resumeAt: resumeAtMs == null ? null : iso(resumeAtMs),
});

export async function deliver({ user, candidate, now, transport, consentStore }) {
  const nowMs = parseTime(now);
  if (Number.isNaN(nowMs)) return withheld('The current time is not valid, so nothing was sent.');
  const type = candidate.type;

  // 1. The user switched this kind off in notification settings: nothing at all.
  if (user.categories?.[type] === false) {
    return withheld(`The user switched off ${type} notifications.`);
  }

  // 2. Local time is needed for the wake-up window.
  if (!validTimezone(user.timezone)) {
    return withheld('The time zone of the user is unknown, so the local time cannot be checked.');
  }

  return withUserState(user.id, async (state) => {
    const tz = user.timezone;
    const prior = state.sent[candidate.id] ?? { push: false, inApp: false };

    // Drop old bookkeeping.
    for (const [id, s] of Object.entries(state.sent)) {
      if (nowMs - s.at > SENT_KEEP_MS) delete state.sent[id];
    }

    if (prior.push && prior.inApp) {
      return { push: true, inApp: true, reason: null, resumeAt: null };
    }

    // 3. Snooze and wake-up window (a snooze that ends outside the window moves to the next window).
    let snoozeMs = null;
    if (user.snoozedUntil != null) {
      snoozeMs = parseTime(user.snoozedUntil);
      if (Number.isNaN(snoozeMs)) {
        return withheld('The snooze time of the user is not readable, so nothing was sent.');
      }
    }
    const snoozed = snoozeMs != null && snoozeMs > nowMs;
    const earliest = snoozed ? snoozeMs : nowMs;
    const allowedAt = nextAllowed(earliest, tz, type);
    if (snoozed) {
      return withheld(`The user snoozed notifications until ${iso(snoozeMs)}.`, allowedAt);
    }
    if (allowedAt !== nowMs) {
      return withheld(
        type === 'briefing' && localParts(nowMs, tz).h >= BRIEFING_END_HOUR
          ? 'It is too late in the morning for the briefing; it waits for the next morning.'
          : 'It is outside the hours when the user wants to be notified.',
        allowedAt,
      );
    }

    // 4. One briefing per local day.
    const today = localDay(nowMs, tz);
    if (type === 'briefing') {
      const lp = localParts(nowMs, tz);
      const other = Object.entries(state.sent).find(
        ([id, s]) => id !== candidate.id && s.type === 'briefing' && s.day === today && (s.push || s.inApp),
      );
      if (other) {
        return withheld(
          'A briefing was already sent today.',
          atLocal(tz, lp.y, lp.m, lp.d + 1, WINDOW_START_HOUR),
        );
      }
    }

    // 5. Push eligibility.
    let pushBlock = null;
    let pushBlockResume = null;
    if (prior.push) {
      pushBlock = 'already pushed';
    } else if (user.notificationsPermitted === false) {
      pushBlock = 'Notifications are turned off for the app in the phone settings, so only the in-app item was added.';
    } else {
      const recent = (state.dismissals[type] ?? []).filter((t) => nowMs - t < DISMISS_WINDOW_MS).sort((a, b) => a - b);
      if (recent.length >= DISMISS_LIMIT) {
        pushBlock = `The user swiped away ${type} cards ${recent.length} times recently, so no push was sent.`;
        pushBlockResume = recent[recent.length - DISMISS_LIMIT] + DISMISS_WINDOW_MS;
      } else {
        let consents = null;
        try {
          consents = await consentStore.get(user.id);
        } catch {
          pushBlock = 'Consent could not be checked right now, so no push was sent.';
        }
        if (!pushBlock && consents?.push !== true) {
          pushBlock = 'The user has not agreed to push notifications.';
        }
      }
    }

    // 6. Send.
    const entry = state.sent[candidate.id] ?? (state.sent[candidate.id] = {
      type, day: today, at: nowMs, push: false, inApp: false,
    });
    const problems = [];

    if (!prior.inApp) {
      try {
        await transport.inApp(user, candidate);
        entry.inApp = true;
      } catch {
        problems.push('The in-app item could not be stored.');
      }
    }

    if (!pushBlock) {
      let ok = false;
      try {
        ok = (await transport.push(user, candidate)) === true;
      } catch {
        ok = false;
      }
      if (ok) entry.push = true;
      else problems.push('The phone did not accept the push (for example no device token).');
    } else if (pushBlock !== 'already pushed') {
      problems.push(pushBlock);
    }

    if (!entry.push && !entry.inApp) delete state.sent[candidate.id];

    return {
      push: entry.push,
      inApp: entry.inApp,
      reason: problems.length ? problems.join(' ') : null,
      resumeAt: pushBlockResume != null && !entry.push ? iso(pushBlockResume) : null,
    };
  });
}

export async function recordDismissal(userId, type, now) {
  const nowMs = parseTime(now);
  if (Number.isNaN(nowMs)) throw new Error('recordDismissal needs a valid time');
  await withUserState(userId, async (state) => {
    const list = (state.dismissals[type] ?? []).filter((t) => nowMs - t < DISMISS_WINDOW_MS);
    list.push(nowMs);
    state.dismissals[type] = list;
  });
}
