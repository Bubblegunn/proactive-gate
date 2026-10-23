import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Policy in force today. Rule order follows the preference hierarchy:
// consent, then quiet hours, then the daily cap.
const QUIET_START = 22 * 60;
const QUIET_END = 8 * 60;
const DAILY_CAP = 3;

export const RULES = {
  NO_CONSENT: 'no_consent',
  QUIET_HOURS: 'quiet_hours',
  DAILY_CAP: 'daily_cap',
  INVALID_TIMEZONE: 'invalid_timezone',
};

// ---------------------------------------------------------------- time helpers

const formatters = new Map();

function formatterFor(tz) {
  let f = formatters.get(tz);
  if (!f) {
    // Throws RangeError for an unknown time zone.
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
  return f;
}

function validTimezone(tz) {
  if (typeof tz !== 'string' || tz === '') return false;
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

function localParts(ms, tz) {
  const p = {};
  for (const { type, value } of formatterFor(tz).formatToParts(new Date(ms))) {
    if (type !== 'literal') p[type] = Number(value);
  }
  return p;
}

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (p) => `${p.year}-${pad(p.month)}-${pad(p.day)}`;
const clock = (p) => `${pad(p.hour)}:${pad(p.minute)}`;
const minuteOfDay = (p) => p.hour * 60 + p.minute;

function offsetAt(ms, tz) {
  const p = localParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

// UTC instant at which the wall clock in `tz` reads y-m-d hh:mm.
function zonedToUtc(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const o1 = offsetAt(guess, tz);
  let t = guess - o1;
  const o2 = offsetAt(t, tz);
  if (o2 !== o1) t = guess - o2;
  return t;
}

// Next moment, strictly after the current local day's quiet period starts or
// while it is running, at which local time reads 08:00.
function nextQuietEnd(ms, tz) {
  const p = localParts(ms, tz);
  const addDays = minuteOfDay(p) < QUIET_END ? 0 : 1;
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + addDays));
  return zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 8, 0, tz);
}

function inWindow(minute, start, end) {
  if (start === end) return false;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

function toMs(value, label) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError(`${label} is not a valid date`);
  return ms;
}

function describeLocal(ms, tz) {
  const p = localParts(ms, tz);
  return `${clock(p)} on ${dayKey(p)}`;
}

// -------------------------------------------------------------------- storage

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function userFile(dir, userId) {
  const h = createHash('sha256').update(String(userId)).digest('hex');
  return path.join(dir, 'users', `${h}.jsonl`);
}

async function readEntries(file) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { entries: [], clean: true };
    throw e;
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A torn line from a crashed writer: skip it.
    }
  }
  return { entries, clean: raw === '' || raw.endsWith('\n') };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Exclusive per-user lock shared by every worker process using the same STATE_DIR.
async function withLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const fh = await fs.open(lock, 'wx');
      await fh.writeFile(String(process.pid));
      await fh.close();
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const [st, owner] = await Promise.all([fs.stat(lock), fs.readFile(lock, 'utf8')]);
        const pid = Number(owner);
        const stale = Date.now() - st.mtimeMs > 30000 || (pid > 0 && !pidAlive(pid));
        if (stale) {
          await fs.unlink(lock).catch(() => {});
          continue;
        }
      } catch {
        // Lock vanished or is being written: retry.
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lock}`);
      await sleep(3 + Math.random() * 12);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.unlink(lock).catch(() => {});
  }
}

async function appendEntry(file, entry, clean) {
  const fh = await fs.open(file, 'a');
  try {
    await fh.write((clean ? '' : '\n') + JSON.stringify(entry) + '\n');
    await fh.datasync();
  } finally {
    await fh.close();
  }
}

// ------------------------------------------------------------------- decision

function evaluate({ consent, tz, nowMs, deliveredToday }) {
  if (consent !== true) {
    return { send: false, ruleCode: RULES.NO_CONSENT, availableAt: null };
  }
  if (!validTimezone(tz)) {
    return { send: false, ruleCode: RULES.INVALID_TIMEZONE, availableAt: null };
  }
  const minute = minuteOfDay(localParts(nowMs, tz));
  if (inWindow(minute, QUIET_START, QUIET_END)) {
    return { send: false, ruleCode: RULES.QUIET_HOURS, availableAt: nextQuietEnd(nowMs, tz) };
  }
  if (deliveredToday >= DAILY_CAP) {
    // The cap resets at local midnight, which is inside quiet hours, so the
    // earliest delivery is 08:00 the next local day.
    return { send: false, ruleCode: RULES.DAILY_CAP, availableAt: nextQuietEnd(nowMs, tz) };
  }
  return { send: true, ruleCode: null, availableAt: null };
}

function explain(result, { tz, nowMs }) {
  const when = (ms) => describeLocal(ms, tz);
  const avail = result.availableAt == null ? '' : `, and the earliest it could have been delivered was ${when(result.availableAt)} your local time`;
  switch (result.ruleCode) {
    case null:
      return `It was delivered at ${when(nowMs)} your local time (${tz}).`;
    case RULES.NO_CONSENT:
      return 'It was not sent because we have no record of your consent to receive notifications.';
    case RULES.INVALID_TIMEZONE:
      return `It was not sent because the time zone on the account (${tz}) is not valid, so quiet hours could not be checked.`;
    case RULES.QUIET_HOURS:
      return `It was not sent because it was ${when(nowMs)} your local time (${tz}) and notifications are paused between 22:00 and 08:00${avail}.`;
    case RULES.DAILY_CAP:
      return `It was not sent because ${DAILY_CAP} notifications had already been delivered on ${dayKey(localParts(nowMs, tz))} (your local day) and the limit is ${DAILY_CAP} per day${avail}.`;
    default:
      return 'It was not sent.';
  }
}

export async function decide({ user, notification, now }) {
  if (!user || user.id == null) throw new TypeError('user.id is required');
  if (!notification || notification.id == null) throw new TypeError('notification.id is required');
  const nowMs = toMs(now, 'now');
  const dir = stateDir();
  const file = userFile(dir, user.id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const notificationId = String(notification.id);

  return withLock(file, async () => {
    const { entries, clean } = await readEntries(file);

    // A retry of a notification that was already delivered gets the same
    // answer and is not counted a second time.
    if (entries.some((e) => e.notificationId === notificationId && e.delivered)) {
      return { send: true };
    }

    let deliveredToday = 0;
    if (user.consent === true && validTimezone(user.timezone)) {
      const today = dayKey(localParts(nowMs, user.timezone));
      for (const e of entries) {
        if (!e.delivered) continue;
        const ms = Date.parse(e.at);
        if (Math.abs(ms - nowMs) > 3 * 86400000) continue;
        if (dayKey(localParts(ms, user.timezone)) === today) deliveredToday++;
      }
    }

    const result = evaluate({ consent: user.consent, tz: user.timezone, nowMs, deliveredToday });
    await appendEntry(
      file,
      {
        notificationId,
        at: new Date(nowMs).toISOString(),
        delivered: result.send,
        ruleCode: result.ruleCode,
        availableAt: result.availableAt == null ? null : new Date(result.availableAt).toISOString(),
        text: explain(result, { tz: user.timezone, nowMs }),
      },
      clean,
    );
    return { send: result.send };
  });
}

// -------------------------------------------------------------------- support

export async function whyNotReceived({ userId, from, to }) {
  const fromMs = toMs(from, 'from');
  const toMsValue = toMs(to, 'to');
  const { entries } = await readEntries(userFile(stateDir(), userId));
  return entries
    .filter((e) => {
      const ms = Date.parse(e.at);
      return ms >= fromMs && ms < toMsValue;
    })
    .map(({ notificationId, at, delivered, ruleCode, availableAt, text }) => ({
      notificationId,
      at,
      delivered,
      ruleCode,
      availableAt,
      text,
    }));
}

// -------------------------------------------------------------------- dry run

function parseHm(value, label) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new TypeError(`${label} must be HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}

// Pure replay: reads nothing from STATE_DIR and writes nothing.
export async function dryRun({ events, policy }) {
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  if (!policy || typeof policy !== 'object') throw new TypeError('policy is required');
  const quiet = policy.quietHours == null
    ? null
    : [parseHm(policy.quietHours.start, 'quietHours.start'), parseHm(policy.quietHours.end, 'quietHours.end')];
  const cap = policy.dailyCap == null ? null : Number(policy.dailyCap);
  if (cap !== null && !(cap >= 0)) throw new TypeError('dailyCap must be a non-negative number or null');

  const ordered = events
    .map((event, i) => ({ event, i, ms: toMs(event.at, `events[${i}].at`) }))
    .sort((a, b) => a.ms - b.ms || a.i - b.i);

  const counts = new Map(); // user -> local day -> delivered
  const deliveredIds = new Set();
  let delivered = 0;
  let blocked = 0;

  for (const { event, ms } of ordered) {
    const { user, notification } = event;
    const idKey = `${user.id}\u0000${notification.id}`;
    if (deliveredIds.has(idKey)) {
      delivered++; // same answer as decide() gives a retry, not counted again
      continue;
    }
    let ok = user.consent === true && validTimezone(user.timezone);
    let day;
    if (ok) {
      const p = localParts(ms, user.timezone);
      day = `${user.id}\u0000${dayKey(p)}`;
      if (quiet && inWindow(minuteOfDay(p), quiet[0], quiet[1])) ok = false;
      else if (cap !== null && (counts.get(day) ?? 0) >= cap) ok = false;
    }
    if (ok) {
      counts.set(day, (counts.get(day) ?? 0) + 1);
      deliveredIds.add(idKey);
      delivered++;
    } else {
      blocked++;
    }
  }
  return { delivered, blocked };
}
