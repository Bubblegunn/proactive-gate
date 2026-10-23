import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Current production policy.
const DEFAULT_POLICY = { quietHours: { start: '22:00', end: '08:00' }, dailyCap: 3 };

// ---------- time helpers ----------

const dtfCache = new Map();
function dtf(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

function localParts(ms, tz) {
  const o = {};
  for (const p of dtf(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return {
    y: +o.year, mo: +o.month, d: +o.day,
    h: +o.hour % 24, mi: +o.minute, s: +o.second,
  };
}

function offsetAt(ms, tz) {
  const p = localParts(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

// UTC ms of a local wall-clock time in tz (DST gaps resolve to the shifted time).
function localToUtc(tz, y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  let ts = guess - offsetAt(guess, tz);
  ts = guess - offsetAt(ts, tz);
  return ts;
}

function dayKey(p) {
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

function parseHM(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s));
  if (!m) throw new RangeError(`invalid time "${s}", expected HH:MM`);
  return { h: +m[1], mi: +m[2], min: +m[1] * 60 + +m[2] };
}

function normalizePolicy(policy) {
  const q = policy?.quietHours ?? null;
  let quiet = null;
  if (q) {
    const s = parseHM(q.start);
    const e = parseHM(q.end);
    if (s.min !== e.min) quiet = { s, e, startText: q.start, endText: q.end };
  }
  const cap = policy?.dailyCap ?? null;
  if (cap !== null && (typeof cap !== 'number' || Number.isNaN(cap) || cap < 0)) {
    throw new RangeError('dailyCap must be a non-negative number or null');
  }
  return { quiet, cap };
}

function inQuiet(quiet, p) {
  if (!quiet) return false;
  const m = p.h * 60 + p.mi;
  const { s, e } = quiet;
  return s.min < e.min ? m >= s.min && m < e.min : m >= s.min || m < e.min;
}

// Next instant (> ms) at which the quiet window ends.
function nextQuietEnd(quiet, ms, tz) {
  const p = localParts(ms, tz);
  let c = localToUtc(tz, p.y, p.mo, p.d, quiet.e.h, quiet.e.mi);
  if (c <= ms) {
    const n = new Date(Date.UTC(p.y, p.mo - 1, p.d + 1));
    c = localToUtc(tz, n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), quiet.e.h, quiet.e.mi);
  }
  return c;
}

function nextLocalMidnight(ms, tz) {
  const p = localParts(ms, tz);
  const n = new Date(Date.UTC(p.y, p.mo - 1, p.d + 1));
  return localToUtc(tz, n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), 0, 0);
}

// ---------- rules ----------

// deliveredAts: ms timestamps of notifications already delivered to this user.
function evaluate({ consent, tz, ms, quiet, cap, deliveredAts }) {
  if (consent !== true) {
    return { delivered: false, ruleCode: 'NO_CONSENT', availableAt: null, reason: 'consent' };
  }
  const p = localParts(ms, tz);
  const countOn = (key) => deliveredAts.reduce((n, t) => n + (dayKey(localParts(t, tz)) === key ? 1 : 0), 0);

  const blockedAt = (t) => {
    const lp = localParts(t, tz);
    if (inQuiet(quiet, lp)) return 'QUIET_HOURS';
    if (cap !== null && countOn(dayKey(lp)) >= cap) return 'DAILY_CAP';
    return null;
  };

  const rule = blockedAt(ms);
  if (!rule) return { delivered: true, ruleCode: null, availableAt: null };

  // Earliest later moment when neither rule blocks (assuming nothing else is delivered meanwhile).
  let t = ms;
  let avail = null;
  for (let i = 0; i < 6; i++) {
    const r = blockedAt(t);
    if (!r) { avail = t; break; }
    t = r === 'QUIET_HOURS' ? nextQuietEnd(quiet, t, tz) : nextLocalMidnight(t, tz);
  }
  return {
    delivered: false, ruleCode: rule,
    availableAt: avail === null ? null : new Date(avail).toISOString(),
    localDay: dayKey(p), localTime: `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`,
  };
}

function fmtLocal(ms, tz) {
  const p = localParts(ms, tz);
  return `${dayKey(p)} ${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
}

function explain(ev, { tz, quiet, cap, ms }) {
  if (ev.delivered) return 'This notification was delivered.';
  if (ev.ruleCode === 'NO_CONSENT') {
    return 'This notification was not sent because the user has not given consent to receive notifications.';
  }
  const when = ev.availableAt
    ? ` It could have been delivered from ${fmtLocal(Date.parse(ev.availableAt), tz)} ${tz} local time (${ev.availableAt}).`
    : '';
  if (ev.ruleCode === 'QUIET_HOURS') {
    return `This notification was held because it arrived at ${ev.localTime} local time (${tz}), inside quiet hours (${quiet.startText} to ${quiet.endText}).${when}`;
  }
  return `This notification was not sent because the user had already received ${cap} notification${cap === 1 ? '' : 's'} on ${ev.localDay} (local day, ${tz}), which is the daily limit.${when}`;
}

// ---------- state ----------

function stateDir() {
  const d = process.env.STATE_DIR;
  if (!d) throw new Error('STATE_DIR is not set');
  return d;
}

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 40);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cross-process lock: mkdir is atomic. Stale locks (crashed holder) are removed after 30 s.
async function withLock(dir, name, fn) {
  const lockDir = path.join(dir, 'locks');
  await fs.mkdir(lockDir, { recursive: true });
  const lock = path.join(lockDir, `${name}.lock`);
  for (;;) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > 30000) await fs.rm(lock, { recursive: true, force: true });
      } catch { /* released meanwhile */ }
      await sleep(2 + Math.random() * 10);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lock, { recursive: true, force: true });
  }
}

function userLogPath(dir, userId) {
  return path.join(dir, 'users', `${hash(userId)}.jsonl`);
}

async function readLog(file) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn trailing write */ }
  }
  return out;
}

async function appendLine(file, obj) {
  const fh = await fs.open(file, 'a');
  try {
    await fh.write(JSON.stringify(obj) + '\n');
    await fh.datasync();
  } finally {
    await fh.close();
  }
}

// ---------- public API ----------

export async function decide({ user, notification, now }) {
  const dir = stateDir();
  const policy = normalizePolicy(DEFAULT_POLICY);
  const ms = (now instanceof Date ? now : new Date(now)).getTime();
  if (Number.isNaN(ms)) throw new RangeError('invalid now');
  await fs.mkdir(path.join(dir, 'users'), { recursive: true });
  const file = userLogPath(dir, user.id);

  return withLock(dir, `user-${hash(user.id)}`, async () => {
    const log = await readLog(file);
    // Retry of an already delivered notification: same answer, no second count.
    if (log.some((e) => e.notificationId === notification.id && e.delivered)) return { send: true };

    const deliveredAts = log.filter((e) => e.delivered).map((e) => Date.parse(e.at));
    const ev = evaluate({ consent: user.consent, tz: user.timezone, ms, ...policy, deliveredAts });
    const entry = {
      notificationId: notification.id,
      at: new Date(ms).toISOString(),
      delivered: ev.delivered,
      ruleCode: ev.ruleCode,
      availableAt: ev.availableAt,
      text: explain(ev, { tz: user.timezone, ...policy, ms }),
    };
    await appendLine(file, entry);
    return { send: ev.delivered };
  });
}

export async function whyNotReceived({ userId, from, to }) {
  const dir = stateDir();
  const f = Date.parse(from);
  const t = Date.parse(to);
  if (Number.isNaN(f) || Number.isNaN(t)) throw new RangeError('from and to must be ISO 8601 strings');
  const file = userLogPath(dir, userId);
  const log = await withLock(dir, `user-${hash(userId)}`, () => readLog(file)).catch(async (e) => {
    if (e.code === 'ENOENT') return [];
    throw e;
  });
  return log
    .filter((e) => {
      const a = Date.parse(e.at);
      return a >= f && a < t;
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

// Pure in-memory replay; reads and writes no state.
export async function dryRun({ events, policy }) {
  const pol = normalizePolicy(policy);
  const indexed = events.map((e, i) => ({ e, i, ms: Date.parse(e.at) }));
  indexed.sort((a, b) => a.ms - b.ms || a.i - b.i);
  const delivered = new Map(); // userId -> ms[]
  const seen = new Set(); // userId + notificationId delivered
  let ok = 0;
  let blocked = 0;
  for (const { e, ms } of indexed) {
    const uid = e.user.id;
    const key = `${uid}\u0000${e.notification.id}`;
    if (seen.has(key)) { ok++; continue; }
    const list = delivered.get(uid) ?? [];
    const ev = evaluate({ consent: e.user.consent, tz: e.user.timezone, ms, ...pol, deliveredAts: list });
    if (ev.delivered) {
      list.push(ms);
      delivered.set(uid, list);
      seen.add(key);
      ok++;
    } else {
      blocked++;
    }
  }
  return { delivered: ok, blocked };
}
