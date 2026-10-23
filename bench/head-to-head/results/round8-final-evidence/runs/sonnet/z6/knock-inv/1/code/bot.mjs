// Notification gate: decide (live), whyNotReceived (support), dryRun (policy what-if).
//
// Rule order follows the Knock preference hierarchy: consent, then quiet hours,
// then frequency cap. The first rule that stops a notification is the one reported.
//
// State: STATE_DIR/decisions/<sha256(userId)>.jsonl, one JSON line per decision,
// appended under a per-user lock directory (STATE_DIR/locks/<sha256>.lock) so several
// worker processes can share it. Every decision is logged, delivered or not, so the
// log is the source for both the daily cap and whyNotReceived.

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, open } from 'node:fs/promises';
import { join } from 'node:path';

export const RULE_CODES = Object.freeze({
  NO_CONSENT: 'NO_CONSENT',
  UNKNOWN_TIMEZONE: 'UNKNOWN_TIMEZONE',
  QUIET_HOURS: 'QUIET_HOURS',
  DAILY_CAP: 'DAILY_CAP',
});

const LIVE_POLICY_INPUT = { quietHours: { start: '22:00', end: '08:00' }, dailyCap: 3 };

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 20_000;
const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------- time zones

const formatters = new Map();

function formatterFor(tz) {
  let f = formatters.get(tz);
  if (f === undefined) {
    try {
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
    } catch {
      f = null;
    }
    formatters.set(tz, f);
  }
  return f;
}

function isValidTimeZone(tz) {
  return typeof tz === 'string' && tz !== '' && formatterFor(tz) !== null;
}

const pad = (n) => String(n).padStart(2, '0');

function localParts(ms, tz) {
  const p = {};
  for (const { type, value } of formatterFor(tz).formatToParts(new Date(ms))) p[type] = value;
  const y = Number(p.year);
  const mo = Number(p.month);
  const d = Number(p.day);
  const h = Number(p.hour) % 24;
  const mi = Number(p.minute);
  const s = Number(p.second);
  const frac = ((ms % 1000) + 1000) % 1000;
  return {
    y,
    mo,
    d,
    h,
    mi,
    dateKey: `${y}-${pad(mo)}-${pad(d)}`,
    clock: `${pad(h)}:${pad(mi)}`,
    tod: ((h * 60 + mi) * 60 + s) * 1000 + frac, // ms since local midnight
  };
}

function tzOffsetMs(ms, tz) {
  const base = Math.floor(ms / 1000) * 1000;
  const p = localParts(base, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, Math.floor((p.tod / 1000) % 60)) - base;
}

// Instant at which the wall clock in tz reads y-mo-d h:mi.
function zonedToUtc(tz, y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const t1 = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(t1, tz);
}

function addDays(y, mo, d, n) {
  const dt = new Date(Date.UTC(y, mo - 1, d + n));
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function nextLocalDayStart(tz, lp) {
  const n = addDays(lp.y, lp.mo, lp.d, 1);
  const target = `${n.y}-${pad(n.mo)}-${pad(n.d)}`;
  let t = zonedToUtc(tz, n.y, n.mo, n.d, 0, 0);
  // A zone whose DST change skips midnight has no 00:00; move to the first real instant.
  for (let i = 0; i < 3 && localParts(t, tz).dateKey < target; i++) t += HOUR_MS;
  return t;
}

// ------------------------------------------------------------------- policy

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parsePolicy(policy) {
  if (policy === null || typeof policy !== 'object') throw new TypeError('policy must be an object');
  const { quietHours = null, dailyCap = null } = policy;
  let quiet = null;
  if (quietHours !== null) {
    const s = HHMM.exec(quietHours?.start);
    const e = HHMM.exec(quietHours?.end);
    if (!s || !e) throw new TypeError('policy.quietHours must be { start: "HH:MM", end: "HH:MM" } or null');
    const start = Number(s[1]) * 60 + Number(s[2]);
    const end = Number(e[1]) * 60 + Number(e[2]);
    // start === end is an empty window, not a 24 hour one.
    if (start !== end) {
      quiet = { start, end, startText: quietHours.start, endText: quietHours.end };
    }
  }
  if (dailyCap !== null && !(Number.isInteger(dailyCap) && dailyCap >= 0)) {
    throw new TypeError('policy.dailyCap must be a non-negative integer or null');
  }
  return { quiet, dailyCap };
}

const LIVE_POLICY = parsePolicy(LIVE_POLICY_INPUT);

function inQuietHours(quiet, lp) {
  if (quiet === null) return false;
  const start = quiet.start * 60_000;
  const end = quiet.end * 60_000;
  // The window is [start, end): a notification exactly at the end is allowed.
  return start < end ? lp.tod >= start && lp.tod < end : lp.tod >= start || lp.tod < end;
}

function quietEnd(quiet, tz, lp) {
  const nextDay = quiet.start > quiet.end && lp.tod >= quiet.start * 60_000 ? 1 : 0;
  const day = addDays(lp.y, lp.mo, lp.d, nextDay);
  return zonedToUtc(tz, day.y, day.mo, day.d, Math.floor(quiet.end / 60), quiet.end % 60);
}

// Earliest instant, not before nowMs, that passes quiet hours and the cap.
// counts maps a local date key to the number of deliveries on that day.
function earliestAvailable(policy, tz, nowMs, counts) {
  if (policy.dailyCap === 0) return null;
  let t = nowMs;
  for (let i = 0; i < 8; i++) {
    const lp = localParts(t, tz);
    let next = t;
    if (inQuietHours(policy.quiet, lp)) {
      next = quietEnd(policy.quiet, tz, lp);
    } else if (policy.dailyCap !== null && (counts.get(lp.dateKey) ?? 0) >= policy.dailyCap) {
      next = nextLocalDayStart(tz, lp);
    } else {
      return t;
    }
    if (next <= t) return null;
    t = next;
  }
  return null;
}

// consent must be exactly true: anything else fails closed.
function evaluate(policy, { tz, consent }, nowMs, counts, wantAvailableAt) {
  if (consent !== true) return { send: false, ruleCode: RULE_CODES.NO_CONSENT, availableAt: null };
  if (!isValidTimeZone(tz)) return { send: false, ruleCode: RULE_CODES.UNKNOWN_TIMEZONE, availableAt: null };
  const lp = localParts(nowMs, tz);
  if (inQuietHours(policy.quiet, lp)) {
    return {
      send: false,
      ruleCode: RULE_CODES.QUIET_HOURS,
      availableAt: wantAvailableAt ? earliestAvailable(policy, tz, nowMs, counts) : null,
    };
  }
  if (policy.dailyCap !== null && (counts.get(lp.dateKey) ?? 0) >= policy.dailyCap) {
    return {
      send: false,
      ruleCode: RULE_CODES.DAILY_CAP,
      availableAt: wantAvailableAt ? earliestAvailable(policy, tz, nowMs, counts) : null,
    };
  }
  return { send: true, ruleCode: null, availableAt: null };
}

function countsByLocalDay(deliveredMs, tz) {
  const counts = new Map();
  if (!isValidTimeZone(tz)) return counts;
  for (const ms of deliveredMs) {
    const key = localParts(ms, tz).dateKey;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

// ------------------------------------------------------------------- state

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR environment variable is not set');
  return dir;
}

const userKey = (userId) => createHash('sha256').update(String(userId)).digest('hex');

async function ensureDirs(dir) {
  await mkdir(join(dir, 'decisions'), { recursive: true });
  await mkdir(join(dir, 'locks'), { recursive: true });
}

// mkdir is atomic, so it works as a lock across processes. A lock older than
// LOCK_STALE_MS is taken over (its holder crashed; the critical section lasts milliseconds).
async function withLock(dir, key, fn) {
  const lockPath = join(dir, 'locks', `${key}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    try {
      const st = await stat(lockPath);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        const trash = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
        await rename(lockPath, trash).then(() => rm(trash, { recursive: true, force: true }), () => {});
        continue;
      }
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${key}`);
    await sleep(3 + Math.random() * 12);
  }
  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function readRecords(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const records = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A line torn by a crash mid-write; skip it.
    }
  }
  return records;
}

async function appendRecord(file, record) {
  // The leading newline isolates this record from any torn line before it.
  const fh = await open(file, 'a');
  try {
    await fh.write(`\n${JSON.stringify(record)}\n`);
    await fh.datasync();
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------- decide

export async function decide({ user, notification, now }) {
  if (!user || user.id === undefined || user.id === null || user.id === '') throw new TypeError('user.id is required');
  if (!notification || notification.id === undefined || notification.id === null) throw new TypeError('notification.id is required');
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');

  const dir = stateDir();
  await ensureDirs(dir);
  const key = userKey(user.id);
  const file = join(dir, 'decisions', `${key}.jsonl`);
  const nowMs = now.getTime();

  return withLock(dir, key, async () => {
    const records = await readRecords(file);
    const counts = countsByLocalDay(
      records.filter((r) => r.delivered).map((r) => r.at),
      user.timezone,
    );
    const result = evaluate(LIVE_POLICY, { tz: user.timezone, consent: user.consent }, nowMs, counts, true);
    await appendRecord(file, {
      userId: String(user.id),
      notificationId: notification.id,
      at: nowMs,
      tz: typeof user.timezone === 'string' ? user.timezone : null,
      delivered: result.send,
      ruleCode: result.ruleCode,
      availableAt: result.availableAt,
      policy: LIVE_POLICY_INPUT,
    });
    return { send: result.send };
  });
}

// ------------------------------------------------------- whyNotReceived

function parseInstant(value, name) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) throw new TypeError(`${name} must be an ISO 8601 UTC string`);
  return ms;
}

function localText(ms, tz) {
  const lp = localParts(ms, tz);
  return `${lp.dateKey} ${lp.clock}`;
}

function explain(rec) {
  const tz = rec.tz;
  const quiet = rec.policy?.quietHours;
  const cap = rec.policy?.dailyCap;
  const when = isValidTimeZone(tz) ? `${localText(rec.at, tz)} in the customer's time zone (${tz})` : null;
  const from =
    rec.availableAt === null || rec.availableAt === undefined || when === null
      ? ''
      : `, and the earliest it could be delivered was ${localText(rec.availableAt, tz)} in the customer's time zone`;

  switch (rec.ruleCode) {
    case null:
    case undefined:
      return when === null
        ? 'This notification was delivered.'
        : `This notification was delivered at ${when}.`;
    case RULE_CODES.NO_CONSENT:
      return "This notification was not delivered because the customer has not given consent to receive notifications, so it can only be sent after they opt in.";
    case RULE_CODES.UNKNOWN_TIMEZONE:
      return 'This notification was not delivered because the customer has no valid time zone on file, so quiet hours and the daily limit could not be checked.';
    case RULE_CODES.QUIET_HOURS:
      return `This notification was not delivered because it was considered at ${when}, inside quiet hours (${quiet?.start} to ${quiet?.end})${from}.`;
    case RULE_CODES.DAILY_CAP:
      return `This notification was not delivered because the customer had already received the daily maximum of ${cap} notifications on ${localParts(rec.at, tz).dateKey} (${tz})${from}.`;
    default:
      return `This notification was not delivered (rule ${rec.ruleCode}).`;
  }
}

export async function whyNotReceived({ userId, from, to }) {
  if (userId === undefined || userId === null || userId === '') throw new TypeError('userId is required');
  const fromMs = parseInstant(from, 'from');
  const toMs = parseInstant(to, 'to');
  const file = join(stateDir(), 'decisions', `${userKey(userId)}.jsonl`);
  const records = await readRecords(file);
  return records
    .filter((r) => r.at >= fromMs && r.at < toMs)
    .map((r) => ({
      notificationId: r.notificationId,
      at: new Date(r.at).toISOString(),
      delivered: r.delivered,
      ruleCode: r.ruleCode ?? null,
      availableAt: r.availableAt === null || r.availableAt === undefined ? null : new Date(r.availableAt).toISOString(),
      text: explain(r),
    }));
}

// ---------------------------------------------------------------- dryRun

// Pure: reads and writes nothing in STATE_DIR, sends nothing. Caps are counted
// only from the events passed in, replayed in time order.
export async function dryRun({ events, policy }) {
  const parsed = parsePolicy(policy);
  if (!Array.isArray(events)) throw new TypeError('events must be an array');

  const timeline = events.map((e, index) => {
    const at = parseInstant(e?.at, 'event.at');
    const id = e?.user?.id;
    if (id === undefined || id === null || id === '') throw new TypeError('event.user.id is required');
    return { e, at, index };
  });
  timeline.sort((a, b) => a.at - b.at || a.index - b.index);

  const perUser = new Map(); // user id -> { delivered: ms[], tz, counts }
  let delivered = 0;
  let blocked = 0;
  for (const { e, at } of timeline) {
    const id = String(e.user.id);
    let state = perUser.get(id);
    if (state === undefined) {
      state = { delivered: [], tz: undefined, counts: new Map() };
      perUser.set(id, state);
    }
    const tz = e.user.timezone;
    if (state.tz !== tz) {
      state.tz = tz;
      state.counts = countsByLocalDay(state.delivered, tz);
    }
    const r = evaluate(parsed, { tz, consent: e.user.consent }, at, state.counts, false);
    if (r.send) {
      delivered++;
      state.delivered.push(at);
      const key = localParts(at, tz).dateKey;
      state.counts.set(key, (state.counts.get(key) ?? 0) + 1);
    } else {
      blocked++;
    }
  }
  return { delivered, blocked };
}
