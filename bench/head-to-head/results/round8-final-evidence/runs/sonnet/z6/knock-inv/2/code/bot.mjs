// Notification gate: consent, quiet hours, daily cap.
// Order of checks follows the preference hierarchy: consent, then quiet hours, then frequency cap.
// State: one append-only JSONL decision log per user under STATE_DIR, guarded by a per-user lock directory
// so several worker processes can decide concurrently. Only delivered entries count toward the cap.

import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const DEFAULT_POLICY = { quietHours: { start: '22:00', end: '08:00' }, dailyCap: 3 };
const RESUME_TIME = '08:00'; // end of the default quiet window; used in support text and availableAt

const RULE = {
  NO_CONSENT: 'NO_CONSENT',
  QUIET_HOURS: 'QUIET_HOURS',
  DAILY_CAP: 'DAILY_CAP',
  INVALID_TIMEZONE: 'INVALID_TIMEZONE',
};

// ---------- time helpers ----------

const formatters = new Map();
function formatterFor(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

// Returns { y, m, d, hh, mm } of the instant in tz, or null if tz is not valid.
function localParts(ms, tz) {
  let f;
  try {
    if (typeof tz !== 'string' || !tz) return null;
    f = formatterFor(tz);
  } catch {
    return null;
  }
  const p = {};
  for (const { type, value } of f.formatToParts(new Date(ms))) p[type] = Number(value);
  return { y: p.year, m: p.month, d: p.day, hh: p.hour % 24, mm: p.minute, ss: p.second };
}

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (p) => `${p.y}-${pad(p.m)}-${pad(p.d)}`;
const clock = (p) => `${pad(p.hh)}:${pad(p.mm)}`;

function parseHHMM(s) {
  const m = /^(\d{2}):(\d{2})$/.exec(typeof s === 'string' ? s : '');
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new TypeError(`Invalid HH:MM time: ${JSON.stringify(s)}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

// UTC instant (ms) at which the wall clock in tz reads y-m-d hh:mm.
function zonedToUtc(y, m, d, hh, mm, tz) {
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let t = wall;
  for (let i = 0; i < 3; i++) {
    const p = localParts(t, tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
    const next = t - (asUtc - wall);
    if (next === t) break;
    t = next;
  }
  return t;
}

function addDays(p, n) {
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function toMs(value, label) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError(`Invalid ${label}: ${String(value)}`);
  return ms;
}

function inQuietHours(p, quiet) {
  if (!quiet) return false;
  const s = parseHHMM(quiet.start);
  const e = parseHHMM(quiet.end);
  const m = p.hh * 60 + p.mm;
  if (s === e) return false; // empty window
  return s < e ? m >= s && m < e : m >= s || m < e;
}

// Earliest instant after ms at which the user's clock reads the end of quiet hours (08:00), strictly in the future
// of the local day that follows the blocked moment.
function nextResume(p, tz, quiet, ms) {
  const [rh, rm] = (quiet?.end ?? RESUME_TIME).split(':').map(Number);
  const m = p.hh * 60 + p.mm;
  // Same local day if we are before the resume time (after midnight); otherwise the next local day.
  const day = m < rh * 60 + rm ? { y: p.y, m: p.m, d: p.d } : addDays(p, 1);
  const t = zonedToUtc(day.y, day.m, day.d, rh, rm, tz);
  return t > ms ? t : null;
}

// ---------- rules (shared by decide and dryRun) ----------

/**
 * Pure evaluation of one event.
 * `deliveredToday(localDayKey)` returns how many deliveries already count for that local day.
 */
function evaluate({ user, ms, policy, deliveredToday }) {
  const p = localParts(ms, user?.timezone);
  if (user?.consent !== true) {
    return { delivered: false, ruleCode: RULE.NO_CONSENT, availableAt: null, p };
  }
  if (!p) return { delivered: false, ruleCode: RULE.INVALID_TIMEZONE, availableAt: null, p };

  if (inQuietHours(p, policy.quietHours)) {
    const at = nextResume(p, user.timezone, policy.quietHours, ms);
    return { delivered: false, ruleCode: RULE.QUIET_HOURS, availableAt: at, p };
  }
  const key = dayKey(p);
  const count = deliveredToday(key);
  if (policy.dailyCap !== null && count >= policy.dailyCap) {
    // The cap resets at local midnight; if that is still inside quiet hours, delivery waits for quiet hours to end.
    const next = addDays(p, 1);
    let at = zonedToUtc(next.y, next.m, next.d, 0, 0, user.timezone);
    const q = localParts(at, user.timezone);
    if (inQuietHours(q, policy.quietHours)) at = nextResume(q, user.timezone, policy.quietHours, at) ?? at;
    return { delivered: false, ruleCode: RULE.DAILY_CAP, availableAt: at, p, count };
  }
  return { delivered: true, ruleCode: null, availableAt: null, p, count: count + 1 };
}

function checkPolicy(policy) {
  if (!policy || typeof policy !== 'object') throw new TypeError('policy is required');
  const { quietHours, dailyCap } = policy;
  if (quietHours !== null && quietHours !== undefined) {
    parseHHMM(quietHours.start);
    parseHHMM(quietHours.end);
  }
  if (dailyCap !== null && dailyCap !== undefined && !(Number.isInteger(dailyCap) && dailyCap >= 0)) {
    throw new TypeError(`Invalid dailyCap: ${String(dailyCap)}`);
  }
  return { quietHours: quietHours ?? null, dailyCap: dailyCap ?? null };
}

// ---------- state ----------

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  return dir;
}

function userBase(userId) {
  const h = createHash('sha256').update(String(userId)).digest('hex');
  return path.join(stateDir(), 'users', h);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withLock(base, fn) {
  const lock = `${base}.lock`;
  await fs.mkdir(path.dirname(base), { recursive: true });
  const deadline = Date.now() + 30000;
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > 10000) {
          // Holder probably crashed. Only one process wins the rename.
          const grave = `${lock}.stale.${randomUUID()}`;
          await fs.rename(lock, grave).then(() => fs.rm(grave, { recursive: true, force: true }), () => {});
          continue;
        }
      } catch { /* lock vanished; retry */ }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for lock ${lock}`);
      await sleep(2 + Math.random() * Math.min(20, 2 + attempt));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

async function readLog(base) {
  let raw;
  try {
    raw = await fs.readFile(`${base}.jsonl`, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* ignore a torn line from a crashed writer */ }
  }
  return out;
}

async function appendLog(base, entry) {
  const fh = await fs.open(`${base}.jsonl`, 'a');
  try {
    await fh.write(`\n${JSON.stringify(entry)}\n`);
    await fh.datasync();
  } finally {
    await fh.close();
  }
}

// ---------- public API ----------

export async function decide({ user, notification, now }) {
  if (!user || user.id === undefined || user.id === null) throw new TypeError('user.id is required');
  if (!notification || notification.id === undefined || notification.id === null) throw new TypeError('notification.id is required');
  const ms = toMs(now, 'now');
  const base = userBase(user.id);

  return withLock(base, async () => {
    const log = await readLog(base);
    const deliveredAt = log.filter((e) => e.delivered).map((e) => e.atMs);
    const deliveredToday = (key) => {
      let n = 0;
      for (const t of deliveredAt) {
        const q = localParts(t, user.timezone);
        if (q && dayKey(q) === key) n++;
      }
      return n;
    };
    const r = evaluate({ user, ms, policy: DEFAULT_POLICY, deliveredToday });
    await appendLog(base, {
      userId: user.id,
      notificationId: notification.id,
      atMs: ms,
      at: new Date(ms).toISOString(),
      delivered: r.delivered,
      ruleCode: r.ruleCode,
      availableAt: r.availableAt === null ? null : new Date(r.availableAt).toISOString(),
      timezone: user.timezone ?? null,
      local: r.p ? { day: dayKey(r.p), time: clock(r.p) } : null,
      count: r.count ?? null,
    });
    return { send: r.delivered };
  });
}

function explain(e) {
  const when = e.local ? `${e.local.time} local time` : 'the time it was triggered';
  const resume = e.availableAt && e.timezone && localParts(Date.parse(e.availableAt), e.timezone);
  const resumeText = resume ? `${clock(resume)} local time on ${dayKey(resume)}` : null;
  switch (e.ruleCode) {
    case null:
      return `Delivered at ${when}, as notification ${e.count} of ${DEFAULT_POLICY.dailyCap} allowed for that day.`;
    case RULE.NO_CONSENT:
      return 'Not sent because this account has not given consent to receive notifications, so nothing can be sent until consent is given.';
    case RULE.QUIET_HOURS:
      return `Not sent because it was triggered at ${when}, inside quiet hours (${DEFAULT_POLICY.quietHours.start} to ${DEFAULT_POLICY.quietHours.end}); the earliest it could be delivered was ${resumeText}.`;
    case RULE.DAILY_CAP:
      return `Not sent because the limit of ${DEFAULT_POLICY.dailyCap} notifications for ${e.local?.day ?? 'that day'} had already been reached; the earliest it could be delivered was ${resumeText}.`;
    case RULE.INVALID_TIMEZONE:
      return 'Not sent because the timezone on this account is missing or not recognised, so quiet hours cannot be checked.';
    default:
      return `Not sent (rule ${e.ruleCode}).`;
  }
}

export async function whyNotReceived({ userId, from, to }) {
  const lo = toMs(from, 'from');
  const hi = toMs(to, 'to');
  const base = userBase(userId);
  const log = await withLock(base, () => readLog(base));
  return log
    .filter((e) => e.atMs >= lo && e.atMs < hi)
    .map((e) => ({
      notificationId: e.notificationId,
      at: e.at,
      delivered: e.delivered,
      ruleCode: e.ruleCode,
      availableAt: e.availableAt,
      text: explain(e),
    }));
}

// Replays events against a candidate policy in memory. Reads and writes no state.
export async function dryRun({ events, policy }) {
  const pol = checkPolicy(policy);
  const items = (events ?? []).map((ev, i) => ({ ev, i, ms: toMs(ev.at, 'event.at') }));
  items.sort((a, b) => a.ms - b.ms || a.i - b.i);

  const perUser = new Map(); // user id -> Map(local day -> delivered count)
  let delivered = 0;
  let blocked = 0;
  for (const { ev, ms } of items) {
    const id = String(ev.user?.id);
    if (!perUser.has(id)) perUser.set(id, new Map());
    const days = perUser.get(id);
    const r = evaluate({ user: ev.user, ms, policy: pol, deliveredToday: (k) => days.get(k) ?? 0 });
    if (r.delivered) {
      delivered++;
      const k = dayKey(r.p);
      days.set(k, (days.get(k) ?? 0) + 1);
    } else {
      blocked++;
    }
  }
  return { delivered, blocked };
}
