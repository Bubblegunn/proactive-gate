// Broken A for H2: the hold time is taken from the first full cap only, and the weekly reset assumes a fixed
// UTC+3 offset. Expected FAILS: 3 (both caps full: the hold is the daily midnight, not the Monday reset),
// 4 (monthly full: the hold is the next local midnight, not the month end), 5 (New York weekly reset is
// Monday 00:00 +03 instead of 00:00 EDT). Expected PASSES: 1, 2 (Istanbul is UTC+3, so the fixed offset is
// right there), 6 (storage is correct). Storage and counting are identical to the good reference.
// Standalone: node builtins only.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const LIMITS = { daily: 3, weekly: 7, monthly: 12 };
const fmts = new Map();

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

function localMidnight(y, mo, d, tz) {
  const target = Date.UTC(y, mo - 1, d);
  let t = target;
  for (let i = 0; i < 2; i++) t = target - offset(t, tz);
  return t;
}

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

// Mistake: the next Monday 00:00 is computed with a fixed UTC+3 offset.
function fixedMondayAfter(ms) {
  const plus3 = 3 * 3600e3;
  const w = new Date(ms + plus3);
  const back = (w.getUTCDay() + 6) % 7;
  const monday = Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate() + (7 - back));
  return monday - plus3;
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
        // Mistake: only the first full cap decides the hold. Daily uses the midnight, weekly uses the
        // fixed-offset Monday, and monthly (the only other case) falls back to the next local midnight.
        let hold;
        if (full.includes("daily")) hold = win.daily[1];
        else if (full.includes("weekly")) hold = fixedMondayAfter(ms);
        else hold = win.daily[1];
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
