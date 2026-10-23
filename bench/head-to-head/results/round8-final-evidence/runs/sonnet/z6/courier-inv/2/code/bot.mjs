// Notification gate: decide() applies the live policy, whyNotReceived() explains past
// decisions for support, dryRun() replays events against a candidate policy without side effects.
// State: one append-only JSONL file per user under STATE_DIR, guarded by a lock directory so
// several worker processes can share it.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const LIVE_POLICY = Object.freeze({
  quietHours: Object.freeze({ start: '22:00', end: '08:00' }),
  dailyCap: 3,
});

const RULES = Object.freeze({
  NO_CONSENT: 'no_consent',
  INVALID_TIMEZONE: 'invalid_timezone',
  QUIET_HOURS: 'quiet_hours',
  DAILY_CAP: 'daily_cap',
});

const DAY_MS = 86_400_000;

// ---------- time zone helpers ----------

const formatters = new Map();

function formatterFor(tz) {
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

function isValidTimezone(tz) {
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
  for (const { type, value } of formatterFor(tz).formatToParts(new Date(ms))) p[type] = Number(value);
  return {
    year: p.year,
    month: p.month,
    day: p.day,
    msOfDay: ((p.hour * 60 + p.minute) * 60 + p.second) * 1000 + (((ms % 1000) + 1000) % 1000),
  };
}

function dayKey(ms, tz) {
  const { year, month, day } = localParts(ms, tz);
  return year * 10000 + month * 100 + day;
}

function offsetAt(ms, tz) {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day) + p.msOfDay;
  return asUtc - ms;
}

// UTC instant of a local wall-clock time. Day overflow (day + 1) is normalised by Date.UTC.
function localToUtc(year, month, day, minutes, tz) {
  const guess = Date.UTC(year, month - 1, day, 0, minutes);
  let t = guess - offsetAt(guess, tz);
  const o2 = offsetAt(t, tz);
  if (guess - o2 !== t) t = guess - o2;
  return t;
}

function formatLocal(ms, tz) {
  const { year, month, day, msOfDay } = localParts(ms, tz);
  const mins = Math.floor(msOfDay / 60000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)} ${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
}

// ---------- policy ----------

function parseHHMM(value) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value));
  if (!m) throw new TypeError(`Invalid time "${value}", expected HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function compilePolicy(policy) {
  const q = policy?.quietHours ?? null;
  const cap = policy?.dailyCap ?? null;
  if (cap !== null && (!Number.isInteger(cap) || cap < 0)) {
    throw new TypeError('dailyCap must be a non-negative integer or null');
  }
  let quiet = null;
  if (q) {
    const start = parseHHMM(q.start);
    const end = parseHHMM(q.end);
    if (start !== end) {
      quiet = { start, end, startText: q.start, endText: q.end, wraps: start > end };
    }
  }
  return { quiet, cap };
}

function inQuiet(quiet, msOfDay) {
  if (!quiet) return false;
  const s = quiet.start * 60000;
  const e = quiet.end * 60000;
  return quiet.wraps ? msOfDay >= s || msOfDay < e : msOfDay >= s && msOfDay < e;
}

// End of the quiet window that contains `ms`.
function quietEnd(quiet, ms, tz) {
  const p = localParts(ms, tz);
  const endsNextDay = quiet.wraps && p.msOfDay >= quiet.start * 60000;
  return localToUtc(p.year, p.month, p.day + (endsNextDay ? 1 : 0), quiet.end, tz);
}

function nextMidnight(ms, tz) {
  const p = localParts(ms, tz);
  return localToUtc(p.year, p.month, p.day + 1, 0, tz);
}

// Earliest instant >= fromMs at which both the quiet-hours and the cap rule would pass.
function earliestAvailable(compiled, tz, fromMs, deliveredMs) {
  if (compiled.cap === 0) return null;
  let t = fromMs;
  for (let i = 0; i < 6; i++) {
    const p = localParts(t, tz);
    if (inQuiet(compiled.quiet, p.msOfDay)) {
      t = quietEnd(compiled.quiet, t, tz);
      continue;
    }
    if (compiled.cap !== null) {
      const key = dayKey(t, tz);
      const used = deliveredMs.reduce((n, d) => n + (dayKey(d, tz) === key ? 1 : 0), 0);
      if (used >= compiled.cap) {
        t = nextMidnight(t, tz);
        continue;
      }
    }
    return t;
  }
  return null;
}

// Pure decision. deliveredMs: instants of earlier deliveries to this user.
function evaluate(compiled, user, atMs, deliveredMs) {
  if (user?.consent !== true) {
    return { delivered: false, ruleCode: RULES.NO_CONSENT, availableAt: null };
  }
  const tz = user.timezone;
  if (!isValidTimezone(tz)) {
    return { delivered: false, ruleCode: RULES.INVALID_TIMEZONE, availableAt: null };
  }
  const p = localParts(atMs, tz);
  if (inQuiet(compiled.quiet, p.msOfDay)) {
    const t = earliestAvailable(compiled, tz, atMs, deliveredMs);
    return { delivered: false, ruleCode: RULES.QUIET_HOURS, availableAt: t === null ? null : new Date(t).toISOString() };
  }
  if (compiled.cap !== null) {
    const key = dayKey(atMs, tz);
    const used = deliveredMs.reduce((n, d) => n + (dayKey(d, tz) === key ? 1 : 0), 0);
    if (used >= compiled.cap) {
      const t = earliestAvailable(compiled, tz, atMs, deliveredMs);
      return { delivered: false, ruleCode: RULES.DAILY_CAP, availableAt: t === null ? null : new Date(t).toISOString() };
    }
  }
  return { delivered: true, ruleCode: null, availableAt: null };
}

const LIVE = compilePolicy(LIVE_POLICY);

// ---------- state ----------

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR environment variable is not set');
  fs.mkdirSync(path.join(dir, 'users'), { recursive: true });
  return dir;
}

function userFile(dir, userId) {
  return path.join(dir, 'users', `${Buffer.from(String(userId), 'utf8').toString('base64url')}.jsonl`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withLock(file, fn) {
  const lock = `${file}.lock`;
  const started = Date.now();
  for (;;) {
    try {
      await fsp.mkdir(lock);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const st = await fsp.stat(lock);
        if (Date.now() - st.mtimeMs > 10_000) {
          await fsp.rmdir(lock).catch(() => {});
          continue;
        }
      } catch {
        continue; // lock vanished, retry now
      }
      if (Date.now() - started > 60_000) throw new Error(`Timed out waiting for lock ${lock}`);
      await sleep(2 + Math.random() * 8);
    }
  }
  try {
    return await fn();
  } finally {
    await fsp.rmdir(lock).catch(() => {});
  }
}

async function readRecords(file) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // ignore a torn line
    }
  }
  return out;
}

async function appendRecord(file, record) {
  const fh = await fsp.open(file, 'a');
  try {
    await fh.write(`${JSON.stringify(record)}\n`);
    await fh.datasync();
  } finally {
    await fh.close();
  }
}

// ---------- public API ----------

export async function decide({ user, notification, now }) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  if (!user || user.id === undefined || user.id === null) throw new TypeError('user.id is required');
  const dir = stateDir();
  const file = userFile(dir, user.id);
  const atMs = now.getTime();

  return withLock(file, async () => {
    const records = await readRecords(file);
    const deliveredMs = records.filter((r) => r.delivered).map((r) => Date.parse(r.at));
    const result = evaluate(LIVE, user, atMs, deliveredMs);
    await appendRecord(file, {
      notificationId: notification?.id ?? null,
      at: now.toISOString(),
      delivered: result.delivered,
      ruleCode: result.ruleCode,
      availableAt: result.availableAt,
      tz: typeof user.timezone === 'string' ? user.timezone : null,
    });
    return { send: result.delivered };
  });
}

function explain(r) {
  const tz = r.tz && isValidTimezone(r.tz) ? r.tz : 'UTC';
  const atMs = Date.parse(r.at);
  const when = `${formatLocal(atMs, tz)} (${tz})`;
  const avail = r.availableAt ? `${formatLocal(Date.parse(r.availableAt), tz)} (${tz})` : null;
  const quiet = `${LIVE_POLICY.quietHours.start} to ${LIVE_POLICY.quietHours.end}`;
  switch (r.ruleCode) {
    case null:
    case undefined:
      return `This notification was delivered at ${when}.`;
    case RULES.NO_CONSENT:
      return 'This notification was not delivered because the customer has not given consent to receive notifications.';
    case RULES.INVALID_TIMEZONE:
      return 'This notification was not delivered because the customer has no valid time zone on file, so we could not tell whether it was a good time to send.';
    case RULES.QUIET_HOURS:
      return `This notification was not delivered because it was due at ${when}, which is inside the customer's quiet hours (${quiet} local time)${avail ? `; the earliest it could have been delivered was ${avail}` : ''}.`;
    case RULES.DAILY_CAP:
      return `This notification was not delivered because the customer had already received ${LIVE_POLICY.dailyCap} notifications that local day (the daily limit), at ${when}${avail ? `; the earliest it could have been delivered was ${avail}` : ''}.`;
    default:
      return `This notification was not delivered (rule ${r.ruleCode}).`;
  }
}

export async function whyNotReceived({ userId, from, to }) {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) throw new TypeError('from and to must be ISO 8601 strings');
  const dir = stateDir();
  const file = userFile(dir, userId);
  const records = await readRecords(file);
  return records
    .filter((r) => {
      const t = Date.parse(r.at);
      return t >= fromMs && t < toMs;
    })
    .map((r) => ({
      notificationId: r.notificationId,
      at: r.at,
      delivered: r.delivered,
      ruleCode: r.ruleCode,
      availableAt: r.availableAt,
      text: explain(r),
    }));
}

export async function dryRun({ events, policy }) {
  const compiled = compilePolicy(policy);
  const items = (events ?? []).map((e, i) => {
    const t = Date.parse(e.at);
    if (Number.isNaN(t)) throw new TypeError(`events[${i}].at is not a valid ISO 8601 string`);
    return { e, t, i };
  });
  items.sort((a, b) => a.t - b.t || a.i - b.i);

  // All state lives in this local map: nothing is read from or written to STATE_DIR.
  const deliveredByUser = new Map();
  let delivered = 0;
  let blocked = 0;
  for (const { e, t } of items) {
    const uid = e.user?.id;
    let list = deliveredByUser.get(uid);
    if (!list) deliveredByUser.set(uid, (list = []));
    const r = evaluate(compiled, e.user, t, list);
    if (r.delivered) {
      list.push(t);
      delivered++;
    } else {
      blocked++;
    }
  }
  return { delivered, blocked };
}
