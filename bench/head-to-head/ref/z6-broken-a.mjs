// Broken A for Z6 (support and dry run). Standalone: node builtins, node:sqlite, state in STATE_DIR.
// Mistakes: (1) the log records only blocked decisions, so delivered notifications never appear in whyNotReceived;
// (2) the text carries the ISO UTC instant of the decision ("Not sent at 2026-09-04T12:00:00.000Z ...");
// (3) dryRun writes the events it delivers into the live per-day counter, so it changes what real decisions allow.
// Direct failures: criterion 1 (delivered entries missing), 3 (ISO text), 4 (live cap consumed by the dry run).
// Cascade failures from the same mistakes: 2 (the list it reads has no delivered entries), 5 (dryRun reads the counter that
// the live decisions wrote, so it delivers none), 6 (only 21 of 24 decisions are logged).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const CAP = 3;
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
    const db = new DatabaseSync(join(dir, "z6a.db"));
    db.exec("PRAGMA busy_timeout = 60000");
    retryBusy(() => db.exec("PRAGMA journal_mode = WAL"));
    retryBusy(() =>
      db.exec(
        "CREATE TABLE IF NOT EXISTS log (seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, notification_id TEXT, at TEXT, delivered INTEGER, rule_code TEXT, available_at TEXT, text TEXT);" +
          "CREATE TABLE IF NOT EXISTS sent (user_id TEXT, day TEXT);",
      ),
    );
    handles.set(dir, db);
  }
  return handles.get(dir);
}
function tx(db, fn) {
  retryBusy(() => db.exec("BEGIN IMMEDIATE"));
  try {
    const r = fn();
    retryBusy(() => db.exec("COMMIT"));
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
const fmt = new Map();
function parts(zone, date) {
  if (!fmt.has(zone)) fmt.set(zone, new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }));
  const p = {};
  for (const x of fmt.get(zone).formatToParts(date)) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const inQuiet = (m, s, e) => m >= s || m < e; // 22:00 to 08:00 wraps midnight
// the instant at which the local wall clock in zone reads day at minutes (offset-corrected twice)
function wallToInstant(zone, day, minutes) {
  const [y, mo, d] = day.split("-").map(Number);
  const target = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
  const off = (t) => {
    const p = parts(zone, new Date(t));
    const [py, pmo, pd] = p.day.split("-").map(Number);
    return Date.UTC(py, pmo - 1, pd, Math.floor(p.minutes / 60), p.minutes % 60) - t;
  };
  let t = target - off(target);
  return target - off(t);
}
function nextDay(day) {
  const [y, mo, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().slice(0, 10);
}

export async function decide({ user, notification, now }) {
  const db = open();
  const lp = parts(user.timezone, now);
  return tx(db, () => {
    const used = db.prepare("SELECT COUNT(*) AS n FROM sent WHERE user_id = ? AND day = ?").get(user.id, lp.day).n;
    let res;
    const midnight = wallToInstant(user.timezone, nextDay(lp.day), 0);
    if (!user.consent) res = { ok: false, rule: "NO_CONSENT", avail: null };
    else if (inQuiet(lp.minutes, 22 * 60, 8 * 60)) {
      const morning = wallToInstant(user.timezone, lp.minutes < 8 * 60 ? lp.day : nextDay(lp.day), 8 * 60);
      res = { ok: false, rule: "QUIET_HOURS", avail: new Date(used >= CAP ? Math.max(morning, midnight) : morning).toISOString() };
    } else if (used >= CAP) res = { ok: false, rule: "DAILY_CAP", avail: new Date(midnight).toISOString() };
    else res = { ok: true, rule: null, avail: null };
    if (res.ok) {
      db.prepare("INSERT INTO sent (user_id, day) VALUES (?, ?)").run(user.id, lp.day);
    } else {
      const text = `Not sent at ${now.toISOString()} (${res.rule}).`;
      db.prepare("INSERT INTO log (user_id, notification_id, at, delivered, rule_code, available_at, text) VALUES (?, ?, ?, 0, ?, ?, ?)").run(
        user.id, notification.id, now.toISOString(), res.rule, res.avail, text,
      );
    }
    return { send: res.ok };
  });
}

export async function whyNotReceived({ userId, from, to }) {
  const db = open();
  return db
    .prepare("SELECT * FROM log WHERE user_id = ? AND at >= ? AND at < ? ORDER BY seq")
    .all(userId, from, to)
    .map((r) => ({
      notificationId: r.notification_id,
      at: r.at,
      delivered: false,
      ruleCode: r.rule_code,
      availableAt: r.available_at,
      text: r.text,
    }));
}

// mistake 3: the delivered events are written into the live counter
export async function dryRun({ events, policy }) {
  const db = open();
  const q = policy && policy.quietHours;
  const toM = (s) => s.split(":").map(Number).reduce((a, b) => a * 60 + b);
  let delivered = 0;
  let blocked = 0;
  return tx(db, () => {
    for (const e of [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
      const lp = parts(e.user.timezone, new Date(e.at));
      const used = db.prepare("SELECT COUNT(*) AS n FROM sent WHERE user_id = ? AND day = ?").get(e.user.id, lp.day).n;
      const quiet = q && inQuiet(lp.minutes, toM(q.start), toM(q.end));
      if (!e.user.consent || quiet || (policy.dailyCap !== null && used >= policy.dailyCap)) blocked++;
      else {
        delivered++;
        db.prepare("INSERT INTO sent (user_id, day) VALUES (?, ?)").run(e.user.id, lp.day);
      }
    }
    return { delivered, blocked };
  });
}
