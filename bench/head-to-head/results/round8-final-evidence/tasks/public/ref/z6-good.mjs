// Reference for Z6 support and dry run (decide, whyNotReceived, dryRun). Standalone: node builtins only (node:sqlite on
// Node 22+), state in STATE_DIR.
// Rules applied by decide, in this order (the first that holds blocks):
//   1. consent: user.consent false -> NO_CONSENT, availableAt null.
//   2. quiet hours: local time 22:00 up to but not including 08:00 -> QUIET_HOURS. availableAt is the next local 08:00;
//      if the daily cap is also reached, availableAt is the later of that and the next local midnight.
//   3. daily cap: 3 delivered notifications already on this local day -> DAILY_CAP, availableAt is the next local midnight.
// Every considered notification is logged (delivered or not) in the same transaction as the decision.
// text is one sentence in local 24-hour HH:MM, never an ISO string and never UTC or GMT.
// dryRun applies a candidate policy to the given events in time order with its own in-memory counters; it writes nothing.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const CAP = 3;
const QUIET_START = 22 * 60;
const QUIET_END = 8 * 60;

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function retryBusy(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (!/locked|busy/i.test(String(e && e.message)) || attempt > 5000) throw e;
      Atomics.wait(sleepBuf, 0, 0, 2 + Math.floor(Math.random() * 15));
    }
  }
}

const handles = new Map();
function open() {
  const dir = process.env.STATE_DIR;
  if (!handles.has(dir)) {
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "z6.db"));
    db.exec("PRAGMA busy_timeout = 60000");
    retryBusy(() => db.exec("PRAGMA journal_mode = WAL"));
    retryBusy(() =>
      db.exec(
        "CREATE TABLE IF NOT EXISTS log (seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, notification_id TEXT NOT NULL, at TEXT NOT NULL, delivered INTEGER NOT NULL, rule_code TEXT, available_at TEXT, text TEXT NOT NULL);",
      ),
    );
    handles.set(dir, db);
  }
  return handles.get(dir);
}

function tx(db, fn) {
  retryBusy(() => db.exec("BEGIN IMMEDIATE"));
  try {
    const result = fn();
    retryBusy(() => db.exec("COMMIT"));
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

const fmtCache = new Map();
// local calendar day, minutes since local midnight, and the wall-clock reading as if it were UTC (for offsets)
function localParts(zone, date) {
  if (!fmtCache.has(zone)) {
    fmtCache.set(
      zone,
      new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
    );
  }
  const p = {};
  for (const part of fmtCache.get(zone).formatToParts(date)) p[part.type] = part.value;
  const y = Number(p.year);
  const mo = Number(p.month);
  const d = Number(p.day);
  const h = Number(p.hour) % 24;
  const mi = Number(p.minute);
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    minutes: h * 60 + mi,
    wall: Date.UTC(y, mo - 1, d, h, mi),
  };
}

// the instant at which the local wall clock in zone reads day (YYYY-MM-DD) at minutes
function wallToInstant(zone, day, minutes) {
  const [y, mo, d] = day.split("-").map(Number);
  const target = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
  const offset = (t) => localParts(zone, new Date(t)).wall - t;
  let t = target - offset(target);
  t = target - offset(t);
  return t;
}

function nextDay(day) {
  const [y, mo, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().slice(0, 10);
}

function quietEnd(zone, lp) {
  const day = lp.minutes < QUIET_END ? lp.day : nextDay(lp.day);
  return wallToInstant(zone, day, QUIET_END);
}

function nextMidnight(zone, lp) {
  return wallToInstant(zone, nextDay(lp.day), 0);
}

function hm(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// minutes in [start, end) on a 24-hour clock, wrapping past midnight when start > end
function inWindow(minutes, start, end) {
  if (start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

function toMinutes(s) {
  const [h, m] = String(s).split(":").map(Number);
  return h * 60 + m;
}

function countDeliveredOnDay(db, userId, zone, day) {
  const rows = db.prepare("SELECT at FROM log WHERE user_id = ? AND delivered = 1").all(userId);
  return rows.filter((r) => localParts(zone, new Date(r.at)).day === day).length;
}

function buildText(zone, now, lp, res) {
  const here = hm(lp.minutes);
  if (res.delivered) return `Sent at ${here}.`;
  if (res.ruleCode === "NO_CONSENT") {
    return `Not sent at ${here} because the customer has not agreed to receive notifications.`;
  }
  const av = localParts(zone, new Date(res.availableAt));
  const tomorrow = av.day !== lp.day ? " tomorrow" : "";
  if (res.ruleCode === "QUIET_HOURS") {
    return `Not sent at ${here} because quiet hours run from 22:00 to 08:00; it can be sent from ${hm(av.minutes)}${tomorrow}.`;
  }
  return `Not sent at ${here} because the limit of ${CAP} notifications for the day was reached; it can be sent from ${hm(av.minutes)}${tomorrow}.`;
}

export async function decide({ user, notification, now }) {
  const db = open();
  const lp = localParts(user.timezone, now);
  return tx(db, () => {
    let res;
    if (!user.consent) {
      res = { delivered: false, ruleCode: "NO_CONSENT", availableAt: null };
    } else {
      const capped = countDeliveredOnDay(db, user.id, user.timezone, lp.day) >= CAP;
      if (inWindow(lp.minutes, QUIET_START, QUIET_END)) {
        let avail = quietEnd(user.timezone, lp);
        if (capped) avail = Math.max(avail, nextMidnight(user.timezone, lp));
        res = { delivered: false, ruleCode: "QUIET_HOURS", availableAt: new Date(avail).toISOString() };
      } else if (capped) {
        res = { delivered: false, ruleCode: "DAILY_CAP", availableAt: new Date(nextMidnight(user.timezone, lp)).toISOString() };
      } else {
        res = { delivered: true, ruleCode: null, availableAt: null };
      }
    }
    const text = buildText(user.timezone, now, lp, res);
    db.prepare(
      "INSERT INTO log (user_id, notification_id, at, delivered, rule_code, available_at, text) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(user.id, notification.id, now.toISOString(), res.delivered ? 1 : 0, res.ruleCode, res.availableAt, text);
    return { send: res.delivered };
  });
}

export async function whyNotReceived({ userId, from, to }) {
  const db = open();
  const lo = Date.parse(from);
  const hi = Date.parse(to);
  const rows = db.prepare("SELECT * FROM log WHERE user_id = ? ORDER BY seq").all(userId);
  return rows
    .filter((r) => {
      const t = Date.parse(r.at);
      return t >= lo && t < hi;
    })
    .map((r) => ({
      notificationId: r.notification_id,
      at: r.at,
      delivered: r.delivered === 1,
      ruleCode: r.rule_code,
      availableAt: r.available_at,
      text: r.text,
    }));
}

export async function dryRun({ events, policy }) {
  const quiet = policy && policy.quietHours ? [toMinutes(policy.quietHours.start), toMinutes(policy.quietHours.end)] : null;
  const cap = policy && Number.isFinite(policy.dailyCap) ? policy.dailyCap : null;
  const ordered = events
    .map((e, i) => ({ e, i, t: Date.parse(e.at) }))
    .sort((a, b) => a.t - b.t || a.i - b.i);
  const used = new Map();
  let delivered = 0;
  let blocked = 0;
  for (const { e, t } of ordered) {
    const lp = localParts(e.user.timezone, new Date(t));
    const key = `${e.user.id}|${lp.day}`;
    const n = used.get(key) || 0;
    if (!e.user.consent) blocked++;
    else if (quiet && inWindow(lp.minutes, quiet[0], quiet[1])) blocked++;
    else if (cap !== null && n >= cap) blocked++;
    else {
      delivered++;
      used.set(key, n + 1);
    }
  }
  return { delivered, blocked };
}
