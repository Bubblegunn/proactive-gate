import fs from 'node:fs/promises';
import path from 'node:path';

// Push is allowed only inside these local-time windows (start inclusive, end exclusive, hours).
const BRIEFING_WINDOW = { start: 7, end: 10 };
const DAYTIME_WINDOW = { start: 8, end: 21 };
const MAX_OTHER_PUSHES_PER_DAY = 3;
const DISMISS_LIMIT = 3;
const DISMISS_DAYS = 14;
const DAY_MS = 86400000;
const PENDING_STALE_MS = 10 * 60 * 1000;
const SENT_KEEP_MS = 3 * DAY_MS;

// ---------- time helpers ----------

function toDate(v) {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const fmtCache = new Map();
function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric',
      day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

function localParts(date, tz) {
  const p = {};
  for (const { type, value } of formatter(tz).formatToParts(date)) p[type] = Number(value);
  return p;
}

function dayKey(date, tz) {
  const p = localParts(date, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

// UTC instant at which the wall clock in `tz` reads hour:00 on the given calendar day.
function zonedInstant(year, month, day, hour, tz) {
  const wall = Date.UTC(year, month - 1, day, hour);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(guess), tz);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess += wall - shown;
  }
  return new Date(guess);
}

// Earliest instant >= t that lies inside the window (t itself when already inside).
function nextInWindow(t, tz, win) {
  const p = localParts(t, tz);
  if (p.hour >= win.start && p.hour < win.end) return t;
  const addDays = p.hour < win.start ? 0 : 1;
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day + addDays));
  return zonedInstant(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), win.start, tz);
}

function nextDayStart(t, tz, win) {
  const p = localParts(t, tz);
  const base = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return zonedInstant(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), win.start, tz);
}

// ---------- shared state (one JSON file per user, guarded by a lock directory) ----------

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function userFile(userId) {
  return path.join(stateDir(), `user-${Buffer.from(String(userId)).toString('hex')}.json`);
}

async function withLock(userId, fn) {
  await fs.mkdir(stateDir(), { recursive: true });
  const lock = `${userFile(userId)}.lock`;
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > 10000) {
          const stale = `${lock}.stale-${process.pid}-${Date.now()}`;
          await fs.rename(lock, stale).then(() => fs.rm(stale, { recursive: true, force: true }), () => {});
          continue;
        }
      } catch { /* lock vanished, retry */ }
      if (Date.now() > deadline) throw new Error('state lock timeout');
      await sleep(5 + Math.random() * 25);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

async function load(userId) {
  try {
    const s = JSON.parse(await fs.readFile(userFile(userId), 'utf8'));
    return { dismissals: s.dismissals ?? {}, sent: s.sent ?? [] };
  } catch (e) {
    if (e.code === 'ENOENT' || e instanceof SyntaxError) return { dismissals: {}, sent: [] };
    throw e;
  }
}

async function save(userId, state) {
  const file = userFile(userId);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(JSON.stringify(state));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
}

function activeDismissals(state, type, nowMs) {
  return (state.dismissals[type] ?? []).filter((t) => nowMs - t < DISMISS_DAYS * DAY_MS);
}

export async function recordDismissal(userId, type, now) {
  const nowMs = (toDate(now) ?? new Date()).getTime();
  await withLock(userId, async () => {
    const state = await load(userId);
    const list = activeDismissals(state, type, nowMs);
    list.push(nowMs);
    state.dismissals[type] = list.slice(-20);
    await save(userId, state);
  });
}

// ---------- delivery ----------

const none = (reason, resumeAt = null) => ({ push: false, inApp: false, reason, resumeAt });

export async function deliver({ user, candidate, now, transport, consentStore }) {
  const nowDate = toDate(now) ?? new Date();
  const nowMs = nowDate.getTime();
  const type = candidate.type;
  const isBriefing = type === 'briefing';
  const win = isBriefing ? BRIEFING_WINDOW : DAYTIME_WINDOW;
  const tz = user.timezone;

  try {
    formatter(tz);
  } catch {
    return none('We do not know the right time zone for this user, so nothing was sent.');
  }

  const categories = user.categories ?? {};

  // 1. The user switched this kind off.
  if (categories[type] === false) {
    return none(`The user switched off ${type} notifications.`);
  }

  // 2. Snooze.
  if (user.snoozedUntil != null) {
    const until = toDate(user.snoozedUntil);
    if (!until) return none('The snooze time could not be read, so nothing was sent.');
    if (until.getTime() > nowMs) {
      const resume = nextInWindow(until, tz, win);
      return none(`The user snoozed notifications until ${until.toISOString()}.`, resume.toISOString());
    }
  }

  // 3. Consent.
  let consents;
  try {
    consents = (await consentStore.get(user.id)) ?? {};
  } catch {
    return none('Consent could not be checked right now, so nothing was sent.');
  }
  for (const key of [type, 'notifications', 'push']) {
    if (consents[key] === false) return none(`The user has not consented to ${key} notifications.`);
  }

  // 4. Time of day.
  const startOfWindow = nextInWindow(nowDate, tz, win);
  const outsideWindow = startOfWindow.getTime() !== nowMs && startOfWindow > nowDate;
  const windowResume = startOfWindow.toISOString();
  if (outsideWindow && isBriefing) {
    return none('It is not morning for this user yet (or the morning has passed).', windowResume);
  }

  // 5. Claim the attempt under the shared lock (dedupe, daily caps, dismissal fatigue).
  let pushAllowed = true;
  let reason = null;
  let resumeAt = null;
  const withhold = (why, at = null) => {
    if (pushAllowed) { reason = why; resumeAt = at; }
    pushAllowed = false;
  };

  if (outsideWindow) withhold('Push waits for daytime hours in the user\'s time zone.', windowResume);

  if (categories[type] !== true) withhold('The user was never asked about this kind of notification, so no push was sent.');
  if (user.notificationsPermitted === false) withhold('Notifications are turned off in the phone settings, so no push was sent.');

  const claimId = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const verdict = await (async () => {
    try {
      return await withLock(user.id, async () => {
        const state = await load(user.id);
        state.sent = state.sent.filter((s) => nowMs - s.at < SENT_KEEP_MS);

        const same = state.sent.find((s) => s.candidateId === candidate.id);
        if (same && (same.status === 'done' || nowMs - same.at < PENDING_STALE_MS)) {
          return { dup: true };
        }
        state.sent = state.sent.filter((s) => s.candidateId !== candidate.id);

        const today = dayKey(nowDate, tz);
        const pushedToday = state.sent.filter((s) => s.push && s.status === 'done' && dayKey(new Date(s.at), tz) === today);
        const pendingToday = state.sent.filter((s) => s.status === 'pending' && dayKey(new Date(s.at), tz) === today);
        if (isBriefing && [...pushedToday, ...pendingToday].some((s) => s.type === 'briefing')) {
          return { once: true };
        }
        const others = [...pushedToday, ...pendingToday].filter((s) => s.type !== 'briefing');
        if (!isBriefing && others.length >= MAX_OTHER_PUSHES_PER_DAY) {
          withhold('Daily limit of push notifications reached.', nextDayStart(nowDate, tz, win).toISOString());
        }

        const recent = activeDismissals(state, type, nowMs);
        if (recent.length >= DISMISS_LIMIT) {
          const releaseAt = recent[recent.length - DISMISS_LIMIT] + DISMISS_DAYS * DAY_MS;
          withhold(`The user dismissed the last ${DISMISS_LIMIT} ${type} cards, so push is paused for now.`,
            nextInWindow(new Date(releaseAt), tz, win).toISOString());
        }

        state.sent.push({ candidateId: candidate.id, type, at: nowMs, status: 'pending', claimId, push: false });
        await save(user.id, state);
        return { ok: true };
      });
    } catch {
      return { error: true };
    }
  })();

  if (verdict.error) return none('Delivery state could not be read, so nothing was sent.');
  if (verdict.dup) return none('This item was already delivered.');
  if (verdict.once) {
    return none('The morning briefing was already sent today.', nextDayStart(nowDate, tz, win).toISOString());
  }

  // 6. Send.
  let push = false;
  let inApp = false;
  if (pushAllowed) {
    try { push = (await transport.push(user, candidate)) === true; } catch { push = false; }
    if (!push) {
      reason = 'The phone did not accept the push (for example no device token).';
      resumeAt = null;
    }
  }
  try {
    await transport.inApp(user, candidate);
    inApp = true;
  } catch {
    inApp = false;
  }

  // 7. Record the outcome (drop the claim when nothing went out so a retry can try again).
  try {
    await withLock(user.id, async () => {
      const state = await load(user.id);
      state.sent = state.sent.filter((s) => !(s.candidateId === candidate.id && s.claimId === claimId));
      if (push || inApp) {
        state.sent.push({ candidateId: candidate.id, type, at: nowMs, status: 'done', push, inApp });
      }
      await save(user.id, state);
    });
  } catch { /* delivery already happened; do not fail the call */ }

  if (!inApp && !reason) reason = 'The in-app item could not be stored.';
  return { push, inApp, reason, resumeAt };
}
