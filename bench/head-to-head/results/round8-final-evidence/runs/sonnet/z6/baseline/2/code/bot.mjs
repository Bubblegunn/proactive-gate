// Notification gate: consent, quiet hours, daily cap.
// State: one append-only JSONL file per user under STATE_DIR, guarded by a
// cross-process lock directory. Every decision (sent or blocked) is logged.
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const LIVE_POLICY = { quietHours: { start: '22:00', end: '08:00' }, dailyCap: 3 };

export const RULES = {
  NO_CONSENT: 'NO_CONSENT',
  QUIET_HOURS: 'QUIET_HOURS',
  DAILY_CAP: 'DAILY_CAP',
  INVALID_TIMEZONE: 'INVALID_TIMEZONE',
};

// ---------- time helpers ----------

const formatters = new Map();
function fmt(tz) {
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
  const o = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o; // year, month, day, hour, minute, second
}

function offsetMs(ms, tz) {
  const p = localParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

// UTC instant at which the wall clock in tz reads the given local time.
function localToUtc(y, mo, d, h, mi, tz) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, 0);
  let guess = wall - offsetMs(wall, tz);
  guess = wall - offsetMs(guess, tz);
  return guess;
}

function dayKey(ms, tz) {
  const p = localParts(ms, tz);
  return p.year * 10000 + p.month * 100 + p.day;
}

function nextLocalMidnight(ms, tz) {
  const p = localParts(ms, tz);
  let t = localToUtc(p.year, p.month, p.day + 1, 0, 0, tz);
  if (t <= ms) t = localToUtc(p.year, p.month, p.day + 2, 0, 0, tz);
  return t;
}

function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s));
  if (!m || +m[1] > 24 || +m[2] > 59) throw new Error(`bad time of day: ${s}`);
  return (+m[1] % 24) * 60 + +m[2];
}

function validTz(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { fmt(tz); return true; } catch { return false; }
}

// Quiet window [start, end) on the local clock, may wrap midnight.
// start === end is an empty window.
function inQuiet(ms, tz, q) {
  if (!q) return false;
  const s = parseHM(q.start), e = parseHM(q.end);
  const p = localParts(ms, tz);
  const m = p.hour * 60 + p.minute;
  return s < e ? m >= s && m < e : s > e ? m >= s || m < e : false;
}

// First instant at or after ms that is outside the quiet window.
function quietEnd(ms, tz, q) {
  if (!inQuiet(ms, tz, q)) return ms;
  const s = parseHM(q.start), e = parseHM(q.end);
  const p = localParts(ms, tz);
  const m = p.hour * 60 + p.minute;
  const dayOffset = s > e && m >= s ? 1 : 0;
  return localToUtc(p.year, p.month, p.day + dayOffset, Math.floor(e / 60), e % 60, tz);
}

// ---------- the rules ----------

// Pure. countToday = deliveries already counted on the local day of ms.
function evaluate({ consent, tz, ms, countToday, policy }) {
  if (consent !== true) return { send: false, code: RULES.NO_CONSENT, availableAt: null };
  if (inQuiet(ms, tz, policy.quietHours)) {
    return { send: false, code: RULES.QUIET_HOURS, availableAt: quietEnd(ms, tz, policy.quietHours) };
  }
  if (policy.dailyCap != null && countToday >= policy.dailyCap) {
    const next = nextLocalMidnight(ms, tz);
    return { send: false, code: RULES.DAILY_CAP, availableAt: quietEnd(next, tz, policy.quietHours) };
  }
  return { send: true, code: null, availableAt: null };
}

// ---------- state ----------

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

const userFile = (dir, userId) =>
  join(dir, 'users', createHash('sha256').update(String(userId)).digest('hex') + '.jsonl');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withLock(path, fn) {
  const lock = path + '.lock';
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await stat(lock);
        if (Date.now() - st.mtimeMs > 10000) { // holder died
          const dead = `${lock}.dead.${randomBytes(6).toString('hex')}`;
          await rename(lock, dead).catch(() => {});
          await rm(dead, { recursive: true, force: true });
          continue;
        }
      } catch { continue; }
      if (Date.now() > deadline) throw new Error(`lock timeout: ${lock}`);
      await sleep(3 + Math.random() * 12);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function readLog(file) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return { records: [], dirtyTail: false }; throw e; }
  const records = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { records.push(JSON.parse(line)); } catch { /* torn write from a crash */ }
  }
  return { records, dirtyTail: text.length > 0 && !text.endsWith('\n') };
}

async function appendRecord(file, record, dirtyTail) {
  const fh = await open(file, 'a');
  try {
    await fh.write((dirtyTail ? '\n' : '') + JSON.stringify(record) + '\n');
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// ---------- public API ----------

function toMs(v, what) {
  const ms = v instanceof Date ? v.getTime() : new Date(v).getTime();
  if (!Number.isFinite(ms)) throw new Error(`invalid ${what}`);
  return ms;
}

export async function decide({ user, notification, now }) {
  if (!user || user.id == null) throw new Error('user.id required');
  if (!notification || notification.id == null) throw new Error('notification.id required');
  const ms = toMs(now, 'now');
  const dir = stateDir();
  await mkdir(join(dir, 'users'), { recursive: true });
  const file = userFile(dir, user.id);

  return withLock(file, async () => {
    const { records, dirtyTail } = await readLog(file);
    let result;
    if (!validTz(user.timezone)) {
      result = { send: false, code: RULES.INVALID_TIMEZONE, availableAt: null };
    } else {
      const today = dayKey(ms, user.timezone);
      const countToday = records.reduce((n, r) => n + (r.send && dayKey(r.ms, user.timezone) === today ? 1 : 0), 0);
      result = evaluate({ consent: user.consent, tz: user.timezone, ms, countToday, policy: LIVE_POLICY });
    }
    await appendRecord(file, {
      u: String(user.id), n: String(notification.id), ms, tz: user.timezone ?? null,
      send: result.send, code: result.code, avail: result.availableAt,
    }, dirtyTail);
    return { send: result.send };
  });
}

function zoneLabel(ms, tz) {
  if (!validTz(tz)) return `${new Date(ms).toISOString()} (UTC)`;
  const p = localParts(ms, tz);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)} (${tz})`;
}

function explain(r) {
  const at = zoneLabel(r.ms, r.tz);
  if (r.send) return `This notification was delivered at ${at}.`;
  const when = r.avail == null ? null : zoneLabel(r.avail, r.tz);
  switch (r.code) {
    case RULES.NO_CONSENT:
      return `This notification was not sent at ${at} because the account has not given consent to receive notifications.`;
    case RULES.QUIET_HOURS:
      return `This notification was not sent at ${at} because it fell in quiet hours (22:00 to 08:00 local time); it could have been sent from ${when}.`;
    case RULES.DAILY_CAP:
      return `This notification was not sent at ${at} because the daily limit of 3 notifications had already been reached for that local day; it could have been sent from ${when}.`;
    case RULES.INVALID_TIMEZONE:
      return `This notification was not sent at ${at} because the account has no valid time zone, so local quiet hours could not be checked.`;
    default:
      return `This notification was not sent at ${at}.`;
  }
}

export async function whyNotReceived({ userId, from, to }) {
  const f = toMs(from, 'from'), t = toMs(to, 'to');
  const file = userFile(stateDir(), userId);
  // Read under the lock so a half-written append is never observed.
  const { records } = await withLockIfExists(file, () => readLog(file));
  return records
    .filter((r) => r.ms >= f && r.ms < t)
    .map((r) => ({
      notificationId: r.n,
      at: new Date(r.ms).toISOString(),
      delivered: r.send,
      ruleCode: r.send ? null : r.code,
      availableAt: !r.send && r.avail != null ? new Date(r.avail).toISOString() : null,
      text: explain(r),
    }));
}

async function withLockIfExists(file, fn) {
  try { await stat(join(file, '..')); } catch { return { records: [] }; }
  return withLock(file, fn);
}

export async function dryRun({ events, policy }) {
  const pol = {
    quietHours: policy?.quietHours ?? null,
    dailyCap: policy?.dailyCap ?? null,
  };
  if (pol.quietHours) { parseHM(pol.quietHours.start); parseHM(pol.quietHours.end); }
  const sorted = events
    .map((e, i) => ({ e, i, ms: toMs(e.at, 'event.at') }))
    .sort((a, b) => a.ms - b.ms || a.i - b.i);

  const sent = new Map(); // user id -> delivered instants (in memory only)
  let delivered = 0, blocked = 0;
  for (const { e, ms } of sorted) {
    const tz = e.user.timezone;
    const list = sent.get(e.user.id) ?? [];
    let res;
    if (!validTz(tz)) {
      res = { send: false };
    } else {
      const today = dayKey(ms, tz);
      const countToday = list.reduce((n, x) => n + (dayKey(x, tz) === today ? 1 : 0), 0);
      res = evaluate({ consent: e.user.consent, tz, ms, countToday, policy: pol });
    }
    if (res.send) { delivered++; list.push(ms); sent.set(e.user.id, list); } else blocked++;
  }
  return { delivered, blocked };
}
