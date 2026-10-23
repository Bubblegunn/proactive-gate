import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// ---- live policy -----------------------------------------------------------

const LIVE_POLICY = { quietHours: { start: '22:00', end: '08:00' }, dailyCap: 3 };

export const RULES = {
  NO_CONSENT: 'NO_CONSENT',
  QUIET_HOURS: 'QUIET_HOURS',
  DAILY_CAP: 'DAILY_CAP',
  INVALID_TIMEZONE: 'INVALID_TIMEZONE',
};

// ---- time helpers ----------------------------------------------------------

const formatters = new Map();

function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
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
  if (typeof tz !== 'string' || !tz) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

function toDate(value, name) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new TypeError(`${name} is not a valid date`);
  return d;
}

/** Local wall-clock parts of an instant in a timezone. */
function localParts(date, tz) {
  const p = {};
  for (const { type, value } of formatter(tz).formatToParts(date)) p[type] = value;
  const year = Number(p.year);
  const month = Number(p.month);
  const day = Number(p.day);
  const secOfDay = Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second);
  return { year, month, day, secOfDay, dayKey: `${p.year}-${p.month}-${p.day}` };
}

/** UTC instant (ms) at which the local clock in tz first shows y-m-d + secOfDay. */
function zonedToUtc(year, month, day, secOfDay, tz) {
  const wall = Date.UTC(year, month - 1, day) + secOfDay * 1000;
  const offsetAt = (t) => {
    const l = localParts(new Date(t), tz);
    return Date.UTC(l.year, l.month - 1, l.day) + l.secOfDay * 1000 - Math.floor(t / 1000) * 1000;
  };
  const t1 = wall - offsetAt(wall);
  return wall - offsetAt(t1);
}

function addDays(year, month, day, n) {
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function parseHHMM(s, name) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(typeof s === 'string' ? s : '');
  if (!m) throw new TypeError(`${name} must be "HH:MM"`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60;
}

function compilePolicy(policy) {
  if (!policy || typeof policy !== 'object') throw new TypeError('policy is required');
  let quiet = null;
  if (policy.quietHours != null) {
    const start = parseHHMM(policy.quietHours.start, 'quietHours.start');
    const end = parseHHMM(policy.quietHours.end, 'quietHours.end');
    if (start !== end) quiet = { start, end };
  }
  let cap = null;
  if (policy.dailyCap != null) {
    if (!Number.isFinite(policy.dailyCap) || policy.dailyCap < 0) {
      throw new TypeError('dailyCap must be a non-negative number or null');
    }
    cap = policy.dailyCap;
  }
  return { quiet, cap };
}

function inQuiet(quiet, secOfDay) {
  if (!quiet) return false;
  const { start, end } = quiet;
  return start < end ? secOfDay >= start && secOfDay < end : secOfDay >= start || secOfDay < end;
}

/** Next instant (after `date`) at which quiet hours end. */
function quietEndsAt(quiet, date, tz) {
  const l = localParts(date, tz);
  const target = l.secOfDay < quiet.end && inQuiet(quiet, l.secOfDay) ? 0 : 1;
  const d = addDays(l.year, l.month, l.day, target);
  return zonedToUtc(d.year, d.month, d.day, quiet.end, tz);
}

/** Earliest moment after the cap blocked at `date`: next local midnight, pushed past quiet hours. */
function capResetsAt(quiet, date, tz) {
  const l = localParts(date, tz);
  const d = addDays(l.year, l.month, l.day, 1);
  const midnight = zonedToUtc(d.year, d.month, d.day, 0, tz);
  if (quiet && inQuiet(quiet, localParts(new Date(midnight), tz).secOfDay)) {
    return quietEndsAt(quiet, new Date(midnight), tz);
  }
  return midnight;
}

// ---- core evaluation (pure) ------------------------------------------------

/**
 * @param deliveredToday number of notifications already delivered on this local day
 * @returns {{ delivered, ruleCode, availableAt: number|null, dayKey, tz }}
 */
function evaluate({ consent, timezone, at, deliveredToday, policy }) {
  if (!validTimezone(timezone)) {
    return { delivered: false, ruleCode: RULES.INVALID_TIMEZONE, availableAt: null, dayKey: null };
  }
  const local = localParts(at, timezone);
  const base = { dayKey: local.dayKey };
  if (consent !== true) {
    return { ...base, delivered: false, ruleCode: RULES.NO_CONSENT, availableAt: null };
  }
  if (inQuiet(policy.quiet, local.secOfDay)) {
    return {
      ...base,
      delivered: false,
      ruleCode: RULES.QUIET_HOURS,
      availableAt: quietEndsAt(policy.quiet, at, timezone),
    };
  }
  if (policy.cap != null && deliveredToday >= policy.cap) {
    return {
      ...base,
      delivered: false,
      ruleCode: RULES.DAILY_CAP,
      availableAt: capResetsAt(policy.quiet, at, timezone),
    };
  }
  return { ...base, delivered: true, ruleCode: null, availableAt: at.getTime() };
}

const LIVE = compilePolicy(LIVE_POLICY);

// ---- persistent state ------------------------------------------------------

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCK_STALE_MS = 15_000;
const LOCK_TIMEOUT_MS = 60_000;

function userPaths(dir, userId) {
  const key = createHash('sha256').update(String(userId)).digest('hex');
  return { file: join(dir, 'users', `${key}.json`), lock: join(dir, 'users', `${key}.lock`) };
}

/** Cross-process mutex per user: atomic mkdir, stale locks are broken. */
async function withUserLock(userId, fn) {
  const dir = stateDir();
  await mkdir(join(dir, 'users'), { recursive: true });
  const { lock } = userPaths(dir, userId);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const s = await stat(lock);
        if (Date.now() - s.mtimeMs > LOCK_STALE_MS) {
          const stale = `${lock}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
          await rename(lock, stale); // only one breaker wins the rename
          await rm(stale, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // lock vanished or was taken over; retry immediately
      }
      if (Date.now() > deadline) throw new Error('timed out waiting for user lock');
      await sleep(5 + Math.random() * 15);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function loadRecords(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8')).records ?? [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function saveRecords(file, records) {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, JSON.stringify({ records }));
  await rename(tmp, file);
}

// ---- API -------------------------------------------------------------------

export async function decide({ user, notification, now }) {
  const at = toDate(now, 'now');
  const id = String(notification.id);
  return withUserLock(user.id, async () => {
    const { file } = userPaths(stateDir(), user.id);
    let records = await loadRecords(file);

    // A delivered notification is final: a retry must not send or count again.
    const prior = records.find((r) => r.notificationId === id);
    if (prior?.delivered) return { send: true };

    // A blocked one is re-evaluated; its entry moves to the end (latest consideration).
    records = records.filter((r) => r.notificationId !== id);

    let deliveredToday = 0;
    if (validTimezone(user.timezone)) {
      const dayKey = localParts(at, user.timezone).dayKey;
      deliveredToday = records.filter((r) => r.delivered && r.dayKey === dayKey).length;
    }
    const result = evaluate({
      consent: user.consent,
      timezone: user.timezone,
      at,
      deliveredToday,
      policy: LIVE,
    });
    records.push({
      notificationId: id,
      at: at.toISOString(),
      delivered: result.delivered,
      ruleCode: result.ruleCode,
      availableAt: result.availableAt == null ? null : new Date(result.availableAt).toISOString(),
      timezone: user.timezone ?? null,
      dayKey: result.dayKey,
      countToday: result.delivered ? deliveredToday + 1 : null,
    });
    await saveRecords(file, records);
    return { send: result.delivered };
  });
}

function clock(iso, tz) {
  const l = localParts(new Date(iso), tz);
  const hh = String(Math.floor(l.secOfDay / 3600)).padStart(2, '0');
  const mm = String(Math.floor((l.secOfDay % 3600) / 60)).padStart(2, '0');
  return { time: `${hh}:${mm}`, date: l.dayKey };
}

function describe(r) {
  if (r.ruleCode === RULES.INVALID_TIMEZONE) {
    return 'We could not send this notification because we do not have a valid time zone for your account, so we could not check your local time.';
  }
  const tz = r.timezone;
  const when = clock(r.at, tz);
  const placed = `at ${when.time} on ${when.date} (${tz} time)`;
  const next = r.availableAt ? clock(r.availableAt, tz) : null;
  const nextText = next ? ` It could have been delivered from ${next.time} on ${next.date} (${tz} time).` : '';
  switch (r.ruleCode) {
    case null:
      return `This notification was delivered ${placed}; it was notification ${r.countToday} of the 3 allowed that day.`;
    case RULES.NO_CONSENT:
      return `We did not send this notification (${placed}) because your account has not given consent to receive notifications.`;
    case RULES.QUIET_HOURS:
      return `We did not send this notification because it was ${when.time} on ${when.date} in your time zone (${tz}), which is inside quiet hours (22:00 to 08:00).${nextText}`;
    case RULES.DAILY_CAP:
      return `We did not send this notification because you had already received the maximum of 3 notifications on ${when.date} in your time zone (${tz}).${nextText}`;
    default:
      return `This notification was not delivered ${placed}.`;
  }
}

export async function whyNotReceived({ userId, from, to }) {
  const lo = toDate(from, 'from').getTime();
  const hi = toDate(to, 'to').getTime();
  const { file } = userPaths(stateDir(), userId);
  // Reads are atomic (file is replaced by rename), so no lock is needed.
  const records = await loadRecords(file);
  return records
    .filter((r) => {
      const t = Date.parse(r.at);
      return t >= lo && t < hi;
    })
    .map((r) => ({
      notificationId: r.notificationId,
      at: r.at,
      delivered: r.delivered,
      ruleCode: r.ruleCode,
      availableAt: r.availableAt,
      text: describe(r),
    }));
}

/** Pure simulation: reads no state, writes no state, sends nothing. */
export async function dryRun({ events, policy }) {
  const compiled = compilePolicy(policy);
  const sorted = events
    .map((e, i) => ({ e, i, t: toDate(e.at, 'event.at').getTime() }))
    .sort((a, b) => a.t - b.t || a.i - b.i);
  const counts = new Map(); // `${userId}|${dayKey}` -> delivered so far
  let delivered = 0;
  let blocked = 0;
  for (const { e, t } of sorted) {
    const at = new Date(t);
    const tz = e.user?.timezone;
    const key = validTimezone(tz) ? `${e.user.id}|${localParts(at, tz).dayKey}` : null;
    const result = evaluate({
      consent: e.user?.consent,
      timezone: tz,
      at,
      deliveredToday: key ? counts.get(key) ?? 0 : 0,
      policy: compiled,
    });
    if (result.delivered) {
      delivered++;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    } else {
      blocked++;
    }
  }
  return { delivered, blocked };
}
