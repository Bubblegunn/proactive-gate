import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const RULE_CODES = Object.freeze({
  NO_CONSENT: 'NO_CONSENT',
  QUIET_HOURS: 'QUIET_HOURS',
  DAILY_CAP: 'DAILY_CAP',
});

// The production policy.
const CURRENT_POLICY = Object.freeze({
  quietHours: Object.freeze({ start: '22:00', end: '08:00' }),
  dailyCap: 3,
});

// ---------- local time helpers ----------

const formatters = new Map();

function formatterFor(tz) {
  let f = formatters.get(tz);
  if (!f) {
    // Throws RangeError for an unknown time zone.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

function localParts(tz, ms) {
  const out = {};
  for (const p of formatterFor(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return { y: out.year, m: out.month, d: out.day, hh: out.hour, mm: out.minute, ss: out.second };
}

function offsetAt(tz, ms) {
  const p = localParts(tz, ms);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(ms / 1000) * 1000;
}

// UTC instant (ms) of local wall-clock y-m-d plus `minutes` after local midnight.
// Day overflow (d = 32, etc.) is normalised by Date.UTC.
function localToUtc(tz, y, m, d, minutes) {
  const wall = Date.UTC(y, m - 1, d, 0, minutes);
  let t = wall - offsetAt(tz, wall);
  const off2 = offsetAt(tz, t);
  t = wall - off2;
  return t;
}

function dayKey(tz, ms) {
  const p = localParts(tz, ms);
  return p.y * 10000 + p.m * 100 + p.d;
}

function minutesOfDay(tz, ms) {
  const p = localParts(tz, ms);
  return p.hh * 60 + p.mm;
}

function nextLocalMidnight(tz, ms) {
  const p = localParts(tz, ms);
  return localToUtc(tz, p.y, p.m, p.d + 1, 0);
}

function parseHHMM(s, label) {
  const m = /^(\d{2}):(\d{2})$/.exec(typeof s === 'string' ? s : '');
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) {
    throw new TypeError(`${label} must be "HH:MM" (00:00 to 23:59), got ${JSON.stringify(s)}`);
  }
  return Number(m[1]) * 60 + Number(m[2]);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatLocal(tz, ms) {
  const p = localParts(tz, ms);
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.hh)}:${pad(p.mm)} (${tz})`;
}

function formatDay(tz, ms) {
  const p = localParts(tz, ms);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

// ---------- policy ----------

function normalizePolicy(policy) {
  if (policy === null || typeof policy !== 'object') throw new TypeError('policy must be an object');
  const { quietHours = null, dailyCap = null } = policy;
  let quiet = null;
  if (quietHours !== null) {
    if (typeof quietHours !== 'object') throw new TypeError('policy.quietHours must be an object or null');
    quiet = {
      start: parseHHMM(quietHours.start, 'quietHours.start'),
      end: parseHHMM(quietHours.end, 'quietHours.end'),
    };
    // start === end is an empty window (the interval [start, end) has length zero).
    if (quiet.start === quiet.end) quiet = null;
  }
  if (dailyCap !== null && !(typeof dailyCap === 'number' && Number.isFinite(dailyCap) && dailyCap >= 0)) {
    throw new TypeError('policy.dailyCap must be a non-negative number or null');
  }
  return { quiet, cap: dailyCap };
}

function inQuiet(quiet, minutes) {
  if (!quiet) return false;
  return quiet.start < quiet.end
    ? minutes >= quiet.start && minutes < quiet.end
    : minutes >= quiet.start || minutes < quiet.end;
}

// Instant at which the quiet window containing `ms` ends, or null when `ms` is not in quiet hours.
function quietEnd(quiet, tz, ms) {
  const mins = minutesOfDay(tz, ms);
  if (!inQuiet(quiet, mins)) return null;
  const p = localParts(tz, ms);
  const nextDay = quiet.start > quiet.end && mins >= quiet.start;
  return localToUtc(tz, p.y, p.m, p.d + (nextDay ? 1 : 0), quiet.end);
}

// Applies the rules in order: consent, quiet hours, daily cap.
// `deliveredMs` are instants of notifications already delivered to this user.
function evaluate({ policy, tz, consent, nowMs, deliveredMs, wantAvailableAt }) {
  const { quiet, cap } = policy;
  if (consent !== true) {
    return { ruleCode: RULE_CODES.NO_CONSENT, availableAt: null };
  }
  const isQuiet = inQuiet(quiet, minutesOfDay(tz, nowMs));
  let sentToday = 0;
  if (!isQuiet && cap !== null) {
    const today = dayKey(tz, nowMs);
    for (const t of deliveredMs) if (dayKey(tz, t) === today) sentToday++;
  }
  const capped = !isQuiet && cap !== null && sentToday >= cap;
  if (!isQuiet && !capped) return { ruleCode: null, availableAt: null };

  const ruleCode = isQuiet ? RULE_CODES.QUIET_HOURS : RULE_CODES.DAILY_CAP;
  let availableAt = null;
  if (wantAvailableAt && !(capped && cap <= 0)) {
    let t = isQuiet ? quietEnd(quiet, tz, nowMs) : nextLocalMidnight(tz, nowMs);
    for (let i = 0; i < 4 && t !== null; i++) {
      const end = quietEnd(quiet, tz, t);
      if (end === null) break;
      t = end;
    }
    availableAt = t;
  }
  return { ruleCode, availableAt, sentToday };
}

// ---------- state: per-user append-only log guarded by a lock directory ----------

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR environment variable is not set');
  return dir;
}

function userFile(dir, userId) {
  const h = createHash('sha256').update(String(userId)).digest('hex');
  return path.join(dir, 'users', `${h}.jsonl`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lockIsStale(lock) {
  try {
    const st = await fsp.stat(lock);
    if (Date.now() - st.mtimeMs > 30_000) return true;
    const pid = Number((await fsp.readFile(path.join(lock, 'owner'), 'utf8')).trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
      } catch (e) {
        if (e.code === 'ESRCH') return true;
      }
    }
    return false;
  } catch (e) {
    return false; // lock released meanwhile, or unreadable: not stale
  }
}

async function withLock(file, fn) {
  const lock = `${file}.lock`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const deadline = Date.now() + 15_000;
  for (let delay = 2; ; delay = Math.min(delay * 2, 40)) {
    try {
      await fsp.mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (await lockIsStale(lock)) {
        // rename is atomic: only one process wins the right to remove a stale lock
        const grave = `${lock}.stale.${process.pid}.${Math.random().toString(36).slice(2)}`;
        try {
          await fsp.rename(lock, grave);
          await fsp.rm(grave, { recursive: true, force: true });
        } catch {}
        continue;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${lock}`);
      await sleep(delay + Math.random() * delay);
    }
  }
  try {
    await fsp.writeFile(path.join(lock, 'owner'), String(process.pid));
    return await fn();
  } finally {
    await fsp.rm(lock, { recursive: true, force: true });
  }
}

async function readEntries(file) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // torn final line from a crashed writer: ignore
    }
  }
  return entries;
}

async function appendEntry(file, entry) {
  const fh = await fsp.open(file, 'a');
  try {
    // leading newline guards against a torn previous line
    await fh.write(`\n${JSON.stringify(entry)}\n`);
    await fh.datasync();
  } finally {
    await fh.close();
  }
}

// ---------- text for support ----------

function describe({ delivered, ruleCode, tz, nowMs, availableAt, cap }) {
  if (delivered) return `This notification was delivered at ${formatLocal(tz, nowMs)}.`;
  const when = availableAt === null ? '' : ` It could have been delivered from ${formatLocal(tz, availableAt)}.`;
  switch (ruleCode) {
    case RULE_CODES.NO_CONSENT:
      return 'This notification was not sent because the customer has not given consent to receive notifications.';
    case RULE_CODES.QUIET_HOURS:
      return `This notification was not sent because it arrived at ${formatLocal(tz, nowMs)}, during quiet hours (22:00 to 08:00 local time).${when}`;
    case RULE_CODES.DAILY_CAP:
      return `This notification was not sent because the customer had already received ${cap} notifications on ${formatDay(tz, nowMs)}, which is the daily limit.${when}`;
    default:
      return 'This notification was not sent.';
  }
}

// ---------- public API ----------

function checkUser(user) {
  if (!user || user.id === undefined || user.id === null || user.id === '') throw new TypeError('user.id is required');
  if (typeof user.timezone !== 'string') throw new TypeError('user.timezone must be an IANA time zone name');
  formatterFor(user.timezone);
}

export async function decide({ user, notification, now }) {
  checkUser(user);
  if (!notification || notification.id === undefined || notification.id === null) {
    throw new TypeError('notification.id is required');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');

  const policy = normalizePolicy(CURRENT_POLICY);
  const nowMs = now.getTime();
  const tz = user.timezone;
  const file = userFile(stateDir(), user.id);

  return withLock(file, async () => {
    const entries = await readEntries(file);
    const nid = String(notification.id);
    // A retry of a notification that was already delivered is answered the same way and not counted twice.
    if (entries.some((e) => e.notificationId === nid && e.delivered)) return { send: true };

    const deliveredMs = entries.filter((e) => e.delivered).map((e) => Date.parse(e.at));
    const r = evaluate({ policy, tz, consent: user.consent, nowMs, deliveredMs, wantAvailableAt: true });
    const delivered = r.ruleCode === null;
    const entry = {
      userId: String(user.id),
      notificationId: nid,
      at: now.toISOString(),
      delivered,
      ruleCode: r.ruleCode,
      availableAt: r.availableAt === null || r.availableAt === undefined ? null : new Date(r.availableAt).toISOString(),
      text: describe({
        delivered,
        ruleCode: r.ruleCode,
        tz,
        nowMs,
        availableAt: r.availableAt ?? null,
        cap: policy.cap,
      }),
    };
    await appendEntry(file, entry);
    return { send: delivered };
  });
}

function parseUtc(s, label) {
  if (typeof s !== 'string') throw new TypeError(`${label} must be an ISO 8601 UTC string`);
  const str = /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? `${s}Z` : s;
  const ms = Date.parse(str);
  if (Number.isNaN(ms)) throw new TypeError(`${label} is not a valid ISO 8601 date: ${s}`);
  return ms;
}

export async function whyNotReceived({ userId, from, to }) {
  const fromMs = parseUtc(from, 'from');
  const toMs = parseUtc(to, 'to');
  const entries = await readEntries(userFile(stateDir(), userId));
  return entries
    .filter((e) => {
      const t = Date.parse(e.at);
      return t >= fromMs && t < toMs;
    })
    .map((e) => ({
      notificationId: e.notificationId,
      at: e.at,
      delivered: e.delivered,
      ruleCode: e.ruleCode,
      availableAt: e.availableAt,
      text: e.text,
    }));
}

export async function dryRun({ events, policy }) {
  const pol = normalizePolicy(policy);
  if (!Array.isArray(events)) throw new TypeError('events must be an array');

  const parsed = events.map((ev, i) => {
    if (!ev || !ev.user) throw new TypeError(`events[${i}].user is required`);
    checkUser(ev.user);
    return { ev, i, ms: parseUtc(ev.at, `events[${i}].at`) };
  });
  parsed.sort((a, b) => a.ms - b.ms || a.i - b.i);

  // Simulated state only; nothing is read from or written to STATE_DIR.
  const perUser = new Map();
  let delivered = 0;
  let blocked = 0;
  for (const { ev, ms } of parsed) {
    const uid = String(ev.user.id);
    let st = perUser.get(uid);
    if (!st) perUser.set(uid, (st = { deliveredMs: [], ids: new Set() }));
    const nid = ev.notification && ev.notification.id != null ? String(ev.notification.id) : null;
    if (nid !== null && st.ids.has(nid)) {
      delivered++; // same replay rule as decide()
      continue;
    }
    const r = evaluate({
      policy: pol,
      tz: ev.user.timezone,
      consent: ev.user.consent,
      nowMs: ms,
      deliveredMs: st.deliveredMs,
      wantAvailableAt: false,
    });
    if (r.ruleCode === null) {
      delivered++;
      st.deliveredMs.push(ms);
      if (nid !== null) st.ids.add(nid);
    } else {
      blocked++;
    }
  }
  return { delivered, blocked };
}
