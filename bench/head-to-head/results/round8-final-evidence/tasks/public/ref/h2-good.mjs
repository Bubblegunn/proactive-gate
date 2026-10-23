// Reference for H2 caps. Standalone: node builtins only (node:sqlite on Node 22+).
// Calendar boundaries come from Intl: a local midnight is found by iterating the zone offset.
// State: STATE_DIR/caps.sqlite, one row per counted message. Each call runs inside BEGIN IMMEDIATE, so
// concurrent processes queue on the write lock and the count and the insert are one step.
// Refused calls are not recorded.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const LIMITS = { daily: 3, weekly: 7, monthly: 12 };
const fmts = new Map();

// Wall-clock fields of an instant in a zone, expressed as a UTC number.
function wallMs(ms, tz) {
  if (!fmts.has(tz)) {
    fmts.set(tz, new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
    }));
  }
  const p = {};
  for (const x of fmts.get(tz).formatToParts(new Date(ms))) p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

const offset = (ms, tz) => wallMs(ms, tz) - Math.floor(ms / 1000) * 1000;

// Instant of local midnight at the start of y-mo-d (mo is 1-based; d may run past the month end).
function localMidnight(y, mo, d, tz) {
  const target = Date.UTC(y, mo - 1, d);
  let t = target;
  for (let i = 0; i < 2; i++) t = target - offset(t, tz);
  return t;
}

// [start, end) of the local day, ISO week (Monday start) and calendar month that contain `ms`.
function windows(ms, tz) {
  const w = new Date(wallMs(ms, tz));
  const y = w.getUTCFullYear();
  const mo = w.getUTCMonth() + 1;
  const d = w.getUTCDate();
  const back = (w.getUTCDay() + 6) % 7;
  return {
    daily: [localMidnight(y, mo, d, tz), localMidnight(y, mo, d + 1, tz)],
    weekly: [localMidnight(y, mo, d - back, tz), localMidnight(y, mo, d - back + 7, tz)],
    monthly: [localMidnight(y, mo, 1, tz), localMidnight(y, mo + 1, 1, tz)],
  };
}

export async function trySend({ user, message, now }) {
  const dir = process.env.STATE_DIR;
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "caps.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout = 20000; CREATE TABLE IF NOT EXISTS sends (user TEXT NOT NULL, at INTEGER NOT NULL);");
    db.exec("BEGIN IMMEDIATE");
    try {
      const ms = now.getTime();
      const win = windows(ms, user.timezone);
      const count = db.prepare("SELECT COUNT(*) AS n FROM sends WHERE user = ? AND at >= ? AND at < ?");
      const full = Object.keys(LIMITS).filter((k) => count.get(user.id, win[k][0], win[k][1]).n >= LIMITS[k]);
      let out;
      if (full.length === 0) {
        db.prepare("INSERT INTO sends (user, at) VALUES (?, ?)").run(user.id, ms);
        out = { sent: true, holdUntil: null, reason: null };
      } else {
        // Every cap that is full must have room again, so the hold is the latest of their resets.
        const hold = Math.max(...full.map((k) => win[k][1]));
        const names = full.map((k) => `the ${k} cap`).join(" and ");
        out = {
          sent: false,
          holdUntil: new Date(hold).toISOString(),
          reason: `Not sent: ${names} ${full.length === 1 ? "is" : "are"} full.`,
        };
      }
      db.exec("COMMIT");
      return out;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  } finally {
    db.close();
  }
}
