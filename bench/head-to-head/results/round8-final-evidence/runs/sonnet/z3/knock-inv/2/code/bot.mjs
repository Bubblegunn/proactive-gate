import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Morning briefing window, in the user's local time. The briefing goes out
// when people wake up (07:00) and is stale after 11:00.
const WAKE_HOUR = 7;
const BRIEFING_END_HOUR = 11;
// Other cards: no push overnight.
const QUIET_START_HOUR = 22;
// Swiping the same card type away this many times within the window stops its push.
const DISMISS_LIMIT = 3;
const DISMISS_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
// A claim still "pending" after this long belongs to a crashed worker.
const STALE_CLAIM_MS = 10 * 60 * 1000;

const BRIEFING = 'briefing';

// ---------- state (shared by several processes through STATE_DIR) ----------

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

const hash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 40);

async function ensure(sub) {
  const dir = path.join(stateDir(), sub);
  await mkdir(dir, { recursive: true });
  return dir;
}

// Dismissals are append-only JSON lines: a single small O_APPEND write is
// atomic, so concurrent workers never lose or corrupt each other's records.
async function dismissalFile(userId) {
  return path.join(await ensure('dismissals'), `${hash(userId)}.jsonl`);
}

async function readDismissals(userId, type) {
  let text;
  try {
    text = await readFile(await dismissalFile(userId), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const times = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.type === type && Number.isFinite(rec.t)) times.push(rec.t);
    } catch {
      // ignore a torn or corrupt line
    }
  }
  return times;
}

export async function recordDismissal(userId, type, now) {
  const t = toDate(now).getTime();
  const file = await dismissalFile(userId);
  await appendFile(file, JSON.stringify({ type, t }) + '\n');
}

// One delivery per claim key. O_EXCL create makes the claim atomic across processes.
async function claimFile(key) {
  return path.join(await ensure('claims'), `${hash(key)}.json`);
}

async function tryClaim(file) {
  const body = JSON.stringify({ state: 'pending', at: Date.now() });
  try {
    await writeFile(file, body, { flag: 'wx' });
    return { ok: true };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  let state = 'pending';
  let age = 0;
  try {
    const st = await stat(file);
    age = Date.now() - st.mtimeMs;
    const rec = JSON.parse(await readFile(file, 'utf8'));
    state = rec.state;
  } catch (e) {
    if (e.code === 'ENOENT') return tryClaim(file);
    // empty or half-written file: another worker is mid-claim, treat as pending
  }
  if (state === 'done') return { ok: false, done: true };
  if (age > STALE_CLAIM_MS) {
    try {
      await unlink(file);
    } catch {
      // another worker already took it over
    }
    return tryClaim(file);
  }
  return { ok: false, done: false };
}

async function finishClaim(file) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify({ state: 'done', at: Date.now() }));
  await rename(tmp, file);
}

async function releaseClaim(file) {
  try {
    await unlink(file);
  } catch {
    // already gone
  }
}

// ---------- time helpers ----------

function toDate(v) {
  const d = v instanceof Date ? new Date(v.getTime()) : new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid time: ${String(v)}`);
  return d;
}

function validTimeZone(tz) {
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
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(date);
  const o = {};
  for (const p of parts) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o;
}

// Offset of the zone from UTC at an instant, in ms.
function zoneOffset(ms, tz) {
  const p = localParts(new Date(ms), tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

// UTC instant of a wall-clock time in a zone (DST safe). dayShift moves the local date.
function zonedInstant(tz, year, month, day, hour, dayShift = 0) {
  const wall = Date.UTC(year, month - 1, day + dayShift, hour, 0, 0);
  let guess = wall - zoneOffset(wall, tz);
  guess = wall - zoneOffset(guess, tz);
  return new Date(guess);
}

// Next instant at or after `from` at which `hour:00` local occurs.
function nextLocalHour(from, tz, hour) {
  const p = localParts(from, tz);
  const today = zonedInstant(tz, p.year, p.month, p.day, hour, 0);
  if (today.getTime() >= from.getTime()) return today;
  return zonedInstant(tz, p.year, p.month, p.day, hour, 1);
}

// Earliest instant at or after `from` that lies inside the briefing window.
function nextBriefingTime(from, tz) {
  const p = localParts(from, tz);
  if (p.hour >= WAKE_HOUR && p.hour < BRIEFING_END_HOUR) return from;
  return nextLocalHour(from, tz, WAKE_HOUR);
}

// ---------- delivery ----------

const result = (push, inApp, reason = null, resumeAt = null) => ({
  push,
  inApp,
  reason,
  resumeAt: resumeAt ? resumeAt.toISOString() : null,
});

export async function deliver({ user, candidate, now, transport, consentStore }) {
  const at = toDate(now);
  const type = candidate.type;
  const isBriefing = type === BRIEFING;

  // 1. The user switched this kind of notification off: nothing at all.
  const choice = user.categories ? user.categories[type] : undefined;
  if (choice === false) {
    return result(false, false, `You turned off ${type} notifications.`);
  }

  // 2. Snoozed: nothing until the snooze ends.
  const snoozeMs = user.snoozedUntil ? Date.parse(user.snoozedUntil) : NaN;
  if (Number.isFinite(snoozeMs) && snoozeMs > at.getTime()) {
    let resume = new Date(snoozeMs);
    if (isBriefing && validTimeZone(user.timezone)) resume = nextBriefingTime(resume, user.timezone);
    return result(false, false, 'Notifications are snoozed.', resume);
  }

  // Local time is needed for the briefing window and for quiet hours.
  const tzOk = validTimeZone(user.timezone);
  if (isBriefing && !tzOk) {
    return result(false, false, 'The time zone of the user is unknown, so the briefing time cannot be chosen.');
  }
  let localDate = at.toISOString().slice(0, 10);
  let quiet = false;
  let quietEnd = null;
  if (tzOk) {
    const p = localParts(at, user.timezone);
    localDate = `${p.year}-${p.month}-${p.day}`;
    if (isBriefing) {
      if (p.hour < WAKE_HOUR || p.hour >= BRIEFING_END_HOUR) {
        const resume = nextLocalHour(at, user.timezone, WAKE_HOUR);
        const early = p.hour < WAKE_HOUR;
        return result(
          false,
          false,
          early
            ? 'It is too early for the morning briefing.'
            : 'The morning briefing time has passed for today.',
          resume,
        );
      }
    } else if (p.hour >= QUIET_START_HOUR || p.hour < WAKE_HOUR) {
      quiet = true;
      quietEnd = nextLocalHour(at, user.timezone, WAKE_HOUR);
    }
  }

  // 3. Decide whether the push surface may be used.
  let pushBlock = null; // { reason, resume }
  if (choice !== true) {
    pushBlock = { reason: `No push choice for ${type} notifications has been made yet.`, resume: null };
  } else if (user.notificationsPermitted === false) {
    pushBlock = { reason: 'Notifications are not permitted in the phone settings.', resume: null };
  } else if (quiet) {
    pushBlock = { reason: 'Push is held during quiet hours.', resume: quietEnd };
  } else {
    const times = (await readDismissals(user.id, type))
      .filter((t) => t <= at.getTime() && t > at.getTime() - DISMISS_WINDOW_MS)
      .sort((a, b) => b - a);
    if (times.length >= DISMISS_LIMIT) {
      pushBlock = {
        reason: `You dismissed ${type} cards ${DISMISS_LIMIT} times recently, so push is paused.`,
        resume: new Date(times[DISMISS_LIMIT - 1] + DISMISS_WINDOW_MS),
      };
    }
  }
  if (!pushBlock) {
    let consents;
    try {
      consents = await consentStore.get(user.id);
    } catch {
      pushBlock = { reason: 'Push consent could not be checked, so push was not sent.', resume: null };
    }
    if (!pushBlock && consents && (consents.push === false || consents[type] === false)) {
      pushBlock = { reason: 'Push consent was withdrawn.', resume: null };
    }
  }

  // 4. One delivery per user per day for the briefing, per card id otherwise.
  const key = isBriefing ? `${user.id}|briefing|${localDate}` : `${user.id}|${candidate.id}`;
  const file = await claimFile(key);
  const claim = await tryClaim(file);
  if (!claim.ok) {
    return result(
      false,
      false,
      claim.done ? 'This notification was already delivered.' : 'This notification is being delivered by another worker.',
    );
  }

  let push = false;
  let inApp = false;
  let pushError = null;
  let inAppError = null;
  if (!pushBlock) {
    try {
      push = (await transport.push(user, candidate)) === true;
    } catch (e) {
      pushError = e;
    }
  }
  try {
    await transport.inApp(user, candidate);
    inApp = true;
  } catch (e) {
    inAppError = e;
  }

  if (!push && !inApp && (pushError || inAppError)) {
    await releaseClaim(file); // nothing reached the user, allow a retry
    throw pushError || inAppError;
  }
  await finishClaim(file);

  let reason = null;
  let resume = null;
  if (pushBlock) {
    reason = pushBlock.reason;
    resume = pushBlock.resume;
  } else if (pushError) {
    reason = 'The push could not be sent.';
  } else if (!push) {
    reason = 'The phone did not accept the push.';
  }
  if (inAppError) reason = reason ? `${reason} The in-app item could not be stored.` : 'The in-app item could not be stored.';
  return result(push, inApp, reason, resume);
}
