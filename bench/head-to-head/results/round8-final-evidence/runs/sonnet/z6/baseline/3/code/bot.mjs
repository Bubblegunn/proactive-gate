import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_POLICY = { quietHours: { start: '22:00', end: '08:00' }, dailyCap: 3 };

export const RULES = {
  NO_CONSENT: 'NO_CONSENT',
  QUIET_HOURS: 'QUIET_HOURS',
  DAILY_CAP: 'DAILY_CAP',
  BAD_TIMEZONE: 'BAD_TIMEZONE',
};

// ---------- time helpers ----------

const fmtCache = new Map();
function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

function localParts(ms, tz) {
  const o = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second };
}

function dayKey(ms, tz) {
  const p = localParts(ms, tz);
  return p.y * 10000 + p.mo * 100 + p.d;
}

function minuteOfDay(ms, tz) {
  const p = localParts(ms, tz);
  return p.h * 60 + p.mi;
}

// UTC ms of a local wall-clock time; in a DST gap returns the first instant after the gap.
function localToUtc(y, mo, d, h, mi, tz) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, 0);
  const offsetAt = (t) => {
    const p = localParts(t, tz);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000;
  };
  let t = wall - offsetAt(wall);
  t = wall - offsetAt(t);
  const p = localParts(t, tz);
  if (p.y !== y || p.mo !== mo || p.d !== d || p.h !== h || p.mi !== mi) {
    // nonexistent local time (spring forward): move forward to the real boundary
    const t2 = wall - offsetAt(t + 3600e3);
    if (t2 > t) return t2;
  }
  return t;
}

function nextLocalMidnight(ms, tz) {
  const p = localParts(ms, tz);
  const next = new Date(Date.UTC(p.y, p.mo - 1, p.d + 1));
  return localToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, tz);
}

function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s));
  if (!m) throw new Error(`invalid time "${s}"`);
  return +m[1] * 60 + +m[2];
}

function validTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { formatter(tz); return true; } catch { return false; }
}

function compilePolicy(policy) {
  const q = policy.quietHours;
  const quiet = q ? { start: parseHM(q.start), end: parseHM(q.end) } : null;
  const cap = policy.dailyCap === null || policy.dailyCap === undefined ? Infinity : policy.dailyCap;
  return { quiet, cap };
}

function inQuiet(quiet, min) {
  if (!quiet || quiet.start === quiet.end) return false;
  return quiet.start < quiet.end
    ? min >= quiet.start && min < quiet.end
    : min >= quiet.start || min < quiet.end;
}

// Next instant (> ms) at which local time equals the end of quiet hours.
function quietEnd(quiet, ms, tz) {
  const p = localParts(ms, tz);
  const min = p.h * 60 + p.mi;
  const addDays = quiet.start > quiet.end && min >= quiet.start ? 1 : 0;
  const base = new Date(Date.UTC(p.y, p.mo - 1, p.d + addDays));
  return localToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(),
    Math.floor(quiet.end / 60), quiet.end % 60, tz);
}

// ---------- core rule evaluation (pure) ----------

// deliveredMs: instants of earlier delivered notifications for this user.
function evaluate({ consent, tz, nowMs, deliveredMs, pol }) {
  if (!validTimezone(tz)) return { delivered: false, ruleCode: RULES.BAD_TIMEZONE, availableAt: null };
  if (consent !== true) return { delivered: false, ruleCode: RULES.NO_CONSENT, availableAt: null };

  const countOn = (key) => {
    let n = 0;
    for (const t of deliveredMs) if (dayKey(t, tz) === key) n++;
    return n;
  };
  const quietNow = inQuiet(pol.quiet, minuteOfDay(nowMs, tz));
  const capNow = countOn(dayKey(nowMs, tz)) >= pol.cap;
  if (!quietNow && !capNow) return { delivered: true, ruleCode: null, availableAt: null };

  const ruleCode = quietNow ? RULES.QUIET_HOURS : RULES.DAILY_CAP;
  if (pol.cap <= 0) return { delivered: false, ruleCode, availableAt: null };

  let cand = nowMs;
  for (let i = 0; i < 8; i++) {
    if (inQuiet(pol.quiet, minuteOfDay(cand, tz))) { cand = quietEnd(pol.quiet, cand, tz); continue; }
    if (countOn(dayKey(cand, tz)) >= pol.cap) { cand = nextLocalMidnight(cand, tz); continue; }
    return { delivered: false, ruleCode, availableAt: new Date(cand).toISOString() };
  }
  return { delivered: false, ruleCode, availableAt: null };
}

// ---------- persistence ----------

function stateDir() {
  const d = process.env.STATE_DIR;
  if (!d) throw new Error('STATE_DIR is not set');
  return d;
}

function userPaths(userId) {
  const h = crypto.createHash('sha256').update(String(userId)).digest('hex');
  const dir = stateDir();
  return { log: path.join(dir, `u-${h}.jsonl`), lock: path.join(dir, `u-${h}.lock`) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withLock(lockPath, fn) {
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      await fs.mkdir(lockPath);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(lockPath);
        if (Date.now() - st.mtimeMs > 10000) { await fs.rmdir(lockPath).catch(() => {}); continue; }
      } catch { continue; }
      if (Date.now() > deadline) throw new Error('timeout acquiring lock');
      await sleep(5 + Math.random() * 15);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rmdir(lockPath).catch(() => {});
  }
}

async function readLog(file) {
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial trailing write */ }
  }
  return out;
}

async function appendLog(file, entry) {
  const fh = await fs.open(file, 'a');
  try {
    await fh.write(JSON.stringify(entry) + '\n');
    await fh.datasync();
  } finally {
    await fh.close();
  }
}

// ---------- text ----------

function localStr(iso, tz) {
  if (!iso) return '';
  if (!validTimezone(tz)) return iso;
  const p = localParts(Date.parse(iso), tz);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)} (${tz})`;
}

function explain(e) {
  const when = localStr(e.at, e.tz);
  const later = e.availableAt ? ` It could have been delivered from ${localStr(e.availableAt, e.tz)}.` : '';
  switch (e.ruleCode) {
    case null:
      return `Notification ${e.notificationId} was delivered at ${when}.`;
    case RULES.NO_CONSENT:
      return `Notification ${e.notificationId} was not delivered at ${when} because the user had not given consent to receive notifications.`;
    case RULES.QUIET_HOURS:
      return `Notification ${e.notificationId} was not delivered at ${when} because it arrived during quiet hours (22:00 to 08:00 local time).${later}`;
    case RULES.DAILY_CAP:
      return `Notification ${e.notificationId} was not delivered at ${when} because the daily limit of 3 notifications had already been reached for that day.${later}`;
    case RULES.BAD_TIMEZONE:
      return `Notification ${e.notificationId} was not delivered at ${when} because the user's time zone is missing or invalid, so local time could not be determined.`;
    default:
      return `Notification ${e.notificationId} was not delivered at ${when} (rule ${e.ruleCode}).`;
  }
}

// ---------- public API ----------

export async function decide({ user, notification, now }) {
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const { log, lock } = userPaths(user.id);
  await fs.mkdir(stateDir(), { recursive: true });

  return withLock(lock, async () => {
    const entries = await readLog(log);
    const prior = entries.find((e) => e.notificationId === notification.id);
    if (prior) return { send: prior.delivered }; // retry: same answer, nothing counted twice

    const deliveredMs = entries.filter((e) => e.delivered).map((e) => Date.parse(e.at));
    const r = evaluate({
      consent: user.consent, tz: user.timezone, nowMs, deliveredMs, pol: compilePolicy(DEFAULT_POLICY),
    });
    const entry = {
      notificationId: notification.id,
      at: new Date(nowMs).toISOString(),
      delivered: r.delivered,
      ruleCode: r.ruleCode,
      availableAt: r.availableAt,
      tz: user.timezone ?? null,
    };
    entry.text = explain(entry);
    await appendLog(log, entry);
    return { send: r.delivered };
  });
}

export async function whyNotReceived({ userId, from, to }) {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const { log } = userPaths(userId);
  try { await fs.access(stateDir()); } catch { return []; }
  const entries = await readLog(log);
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
  const pol = compilePolicy(policy ?? DEFAULT_POLICY);
  const sorted = events
    .map((ev, i) => ({ ev, i, t: Date.parse(ev.at) }))
    .sort((a, b) => a.t - b.t || a.i - b.i);
  const perUser = new Map(); // in-memory only
  let delivered = 0;
  let blocked = 0;
  for (const { ev, t } of sorted) {
    let st = perUser.get(ev.user.id);
    if (!st) perUser.set(ev.user.id, (st = { seen: new Map(), deliveredMs: [] }));
    let ok = st.seen.get(ev.notification.id);
    if (ok === undefined) {
      ok = evaluate({
        consent: ev.user.consent, tz: ev.user.timezone, nowMs: t, deliveredMs: st.deliveredMs, pol,
      }).delivered;
      st.seen.set(ev.notification.id, ok);
      if (ok) st.deliveredMs.push(t);
    }
    if (ok) delivered++; else blocked++;
  }
  return { delivered, blocked };
}
