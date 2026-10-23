import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

// Current production policy.
const POLICY = { quietHours: { start: '22:00', end: '08:00' }, dailyCap: 3 };

export const RULES = {
  NO_CONSENT: 'NO_CONSENT',
  QUIET_HOURS: 'QUIET_HOURS',
  DAILY_CAP: 'DAILY_CAP',
};

// ---------- time helpers ----------

const fmtCache = new Map();
function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
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

// Local wall clock (as if UTC) minus real instant = offset.
function offsetAt(ms, tz) {
  const p = localParts(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

// Instant of local wall time y-mo-d h:mi in tz. Date.UTC normalises overflowing days.
function zonedToUtc(y, mo, d, h, mi, tz) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, 0);
  let guess = wall - offsetAt(wall, tz);
  guess = wall - offsetAt(guess, tz);
  return guess;
}

function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s));
  if (!m || +m[1] > 24 || +m[2] > 59) throw new RangeError(`invalid time "${s}", expected HH:MM`);
  return +m[1] * 60 + +m[2];
}

function pad(n) { return String(n).padStart(2, '0'); }
function hm(min) { return `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`; }

function dayBounds(ms, tz) {
  const p = localParts(ms, tz);
  return [zonedToUtc(p.y, p.mo, p.d, 0, 0, tz), zonedToUtc(p.y, p.mo, p.d + 1, 0, 0, tz)];
}

function inQuiet(minute, q) {
  const s = parseHM(q.start) % 1440;
  const e = parseHM(q.end) % 1440;
  if (s === e) return false;
  return s < e ? minute >= s && minute < e : minute >= s || minute < e;
}

// Earliest instant >= ms (strictly after a quiet instant) at which local time leaves quiet hours.
function quietEnd(ms, tz, q) {
  const p = localParts(ms, tz);
  const minute = p.h * 60 + p.mi;
  const e = parseHM(q.end) % 1440;
  const addDay = minute < e ? 0 : 1;
  return zonedToUtc(p.y, p.mo, p.d + addDay, Math.floor(e / 60), e % 60, tz);
}

function localLabel(ms, tz) {
  const p = localParts(ms, tz);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`;
}

// ---------- the one rule evaluator (used by decide and dryRun) ----------

/**
 * deliveredBefore: instants (ms) of already delivered notifications for this user.
 * Returns { send, ruleCode, availableAt (ms|null), text }.
 */
function evaluate({ policy, timezone, consent, notificationId, nowMs, deliveredBefore }) {
  const label = localLabel(nowMs, timezone);
  const p = localParts(nowMs, timezone);
  const minute = p.h * 60 + p.mi;

  if (consent !== true) {
    return {
      send: false, ruleCode: RULES.NO_CONSENT, availableAt: null,
      text: `Notification ${notificationId} was not sent because you have not given consent to receive notifications. It can only be sent after you give consent.`,
    };
  }

  const q = policy.quietHours;
  if (q && inQuiet(minute, q)) {
    const at = quietEnd(nowMs, timezone, q);
    return {
      send: false, ruleCode: RULES.QUIET_HOURS, availableAt: at,
      text: `Notification ${notificationId} was not sent because it came at ${label} your local time (${timezone}), inside quiet hours (${q.start} to ${q.end}); the earliest it could be delivered was ${localLabel(at, timezone)}.`,
    };
  }

  const cap = policy.dailyCap;
  if (cap !== null && cap !== undefined) {
    const [start, end] = dayBounds(nowMs, timezone);
    const count = deliveredBefore.filter((t) => t >= start && t < end).length;
    if (count >= cap) {
      let at = end;
      if (q) {
        const ep = localParts(at, timezone);
        if (inQuiet(ep.h * 60 + ep.mi, q)) at = quietEnd(at, timezone, q);
      }
      return {
        send: false, ruleCode: RULES.DAILY_CAP, availableAt: at,
        text: `Notification ${notificationId} was not sent because you had already received ${count} notification${count === 1 ? '' : 's'} on ${label.slice(0, 10)} (your local day), which is the daily limit of ${cap}; the earliest it could be delivered was ${localLabel(at, timezone)}.`,
      };
    }
  }

  return {
    send: true, ruleCode: null, availableAt: nowMs,
    text: `Notification ${notificationId} was delivered at ${label} your local time (${timezone}).`,
  };
}

// ---------- persistent state ----------

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error('STATE_DIR is not set');
  fs.mkdirSync(path.join(dir, 'users'), { recursive: true });
  return dir;
}

function userFile(userId) {
  const h = crypto.createHash('sha256').update(String(userId)).digest('hex');
  return path.join(stateDir(), 'users', `${h}.jsonl`);
}

function readLog(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial trailing line */ }
  }
  return out;
}

async function withLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10000) { fs.rmdirSync(lock); continue; }
      } catch { continue; }
      if (Date.now() > deadline) throw new Error(`timeout waiting for lock ${lock}`);
      await sleep(2 + Math.random() * 8);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.rmdirSync(lock); } catch { /* already gone */ }
  }
}

function appendDurable(file, obj) {
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, JSON.stringify(obj) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());

// ---------- API ----------

export async function decide({ user, notification, now }) {
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  if (Number.isNaN(nowMs)) throw new RangeError('invalid now');
  const file = userFile(user.id);
  return withLock(file, () => {
    const log = readLog(file);
    // A repeated decision for the same notification gives the same answer and is not counted twice.
    const prior = log.find((e) => e.notificationId === notification.id);
    if (prior) return { send: prior.delivered };

    const r = evaluate({
      policy: POLICY, timezone: user.timezone, consent: user.consent,
      notificationId: notification.id, nowMs,
      deliveredBefore: log.filter((e) => e.delivered).map((e) => Date.parse(e.at)),
    });
    appendDurable(file, {
      notificationId: notification.id, at: iso(nowMs), delivered: r.send,
      ruleCode: r.ruleCode, availableAt: iso(r.availableAt), text: r.text, timezone: user.timezone,
    });
    return { send: r.send };
  });
}

export async function whyNotReceived({ userId, from, to }) {
  const f = Date.parse(from);
  const t = Date.parse(to);
  if (Number.isNaN(f) || Number.isNaN(t)) throw new RangeError('invalid from/to');
  return readLog(userFile(userId))
    .filter((e) => {
      const a = Date.parse(e.at);
      return a >= f && a < t;
    })
    .map((e) => ({
      notificationId: e.notificationId, at: e.at, delivered: e.delivered,
      ruleCode: e.ruleCode, availableAt: e.availableAt, text: e.text,
    }));
}

export async function dryRun({ events, policy }) {
  const q = policy?.quietHours ?? null;
  const cap = policy?.dailyCap ?? null;
  if (q) { parseHM(q.start); parseHM(q.end); }
  if (cap !== null && (typeof cap !== 'number' || !(cap >= 0))) throw new RangeError('invalid dailyCap');
  const pol = { quietHours: q, dailyCap: cap };

  // Pure in-memory simulation: nothing is read from or written to STATE_DIR.
  const order = events.map((ev, i) => ({ ev, i, ms: Date.parse(ev.at) }));
  for (const o of order) if (Number.isNaN(o.ms)) throw new RangeError(`invalid event time "${o.ev.at}"`);
  order.sort((a, b) => a.ms - b.ms || a.i - b.i);

  const delivered = new Map(); // user id -> delivered instants
  const seen = new Map(); // `${user}\0${notification}` -> verdict, same idempotency as decide
  let ok = 0;
  let blocked = 0;
  for (const { ev, ms } of order) {
    const key = `${ev.user.id}\u0000${ev.notification.id}`;
    let send = seen.get(key);
    if (send === undefined) {
      const list = delivered.get(ev.user.id) ?? [];
      send = evaluate({
        policy: pol, timezone: ev.user.timezone, consent: ev.user.consent,
        notificationId: ev.notification.id, nowMs: ms, deliveredBefore: list,
      }).send;
      if (send) { list.push(ms); delivered.set(ev.user.id, list); }
      seen.set(key, send);
    }
    if (send) ok++; else blocked++;
  }
  return { delivered: ok, blocked };
}
