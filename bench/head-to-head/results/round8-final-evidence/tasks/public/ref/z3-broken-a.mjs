// Broken A for Z3 (a plausible mistake set). Standalone: node builtins only (node:sqlite on Node 22+).
// Derived from z3-good.mjs with four edits:
//   - dismissals are counted across all types (a "suggestion" dismissal silences the briefing);
//   - the Android notification permission is never checked, so the push goes out regardless;
//   - a failed push keeps its reservation, so failed attempts spend the day's allowance;
//   - a consentStore error is treated as consent to push.
// Expected to FAIL criteria 1 (dismissals across types), 3 (failed pushes spend the day), 4 (consent error lets the
// push out) and 5 (permission ignored). Criteria 2 and 6 still pass.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const DISMISS_LIMIT = 3;
const PUSH_PER_DAY = 1;

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
    const db = new DatabaseSync(join(dir, "z3.db"));
    db.exec("PRAGMA busy_timeout = 60000");
    retryBusy(() => db.exec("PRAGMA journal_mode = WAL"));
    retryBusy(() =>
      db.exec(
        "CREATE TABLE IF NOT EXISTS dismissals (user_id TEXT NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL);" +
          "CREATE TABLE IF NOT EXISTS pushes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, day TEXT NOT NULL, status TEXT NOT NULL);",
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

function validZone(z) {
  if (typeof z !== "string" || z.length === 0) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return z;
  } catch {
    return null;
  }
}

const fmtCache = new Map();
function localDay(date, zone) {
  if (!fmtCache.has(zone)) {
    fmtCache.set(zone, new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }));
  }
  const p = {};
  for (const part of fmtCache.get(zone).formatToParts(date)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}

export async function deliver({ user, candidate, now, transport, consentStore }) {
  const type = candidate.type;
  const until = user.snoozedUntil ? Date.parse(user.snoozedUntil) : NaN;
  if (Number.isFinite(until) && now.getTime() < until) {
    return {
      push: false,
      inApp: false,
      reason: "The user snoozed notifications, so this one is held until the snooze ends.",
      resumeAt: new Date(until).toISOString(),
    };
  }
  const categories = user.categories && typeof user.categories === "object" ? user.categories : null;
  if (categories && categories[type] === false) {
    return { push: false, inApp: false, reason: "The user switched this kind of notification off.", resumeAt: null };
  }

  const db = open();
  let pushReason = null;
  if (!categories || categories[type] !== true) {
    pushReason = "The user has not chosen to receive this kind of notification as a push.";
  } else if (
    db.prepare("SELECT COUNT(*) AS n FROM dismissals WHERE user_id = ?").get(user.id).n >= DISMISS_LIMIT
  ) {
    pushReason = "The user dismissed this kind of notification several times, so it stays in the app.";
  }

  if (!pushReason) {
    let consents = null;
    try {
      consents = await consentStore.get(user.id);
    } catch {
      consents = { push: true };
    }
    if (!consents || consents.push !== true) pushReason = "Push consent could not be confirmed, so no push is sent.";
  }

  let push = false;
  if (!pushReason) {
    const day = localDay(now, validZone(user.timezone) ?? "UTC");
    const reservation = tx(db, () => {
      const used = db.prepare("SELECT COUNT(*) AS n FROM pushes WHERE user_id = ? AND day = ?").get(user.id, day).n;
      if (used >= PUSH_PER_DAY) return null;
      return db.prepare("INSERT INTO pushes (user_id, day, status) VALUES (?, ?, 'pending')").run(user.id, day).lastInsertRowid;
    });
    if (reservation === null) {
      pushReason = "The one push for today is already used.";
    } else {
      let accepted = false;
      try {
        accepted = (await transport.push(user, candidate)) === true;
      } catch {
        accepted = false;
      }
      if (accepted) {
        db.prepare("UPDATE pushes SET status = 'sent' WHERE id = ?").run(reservation);
        push = true;
      } else {
        pushReason = "The phone did not accept the push.";
      }
    }
  }

  let inApp = false;
  try {
    await transport.inApp(user, candidate);
    inApp = true;
  } catch {
    inApp = false;
  }
  return { push, inApp, reason: push ? null : pushReason, resumeAt: null };
}

export async function recordDismissal(userId, type, now) {
  const db = open();
  db.prepare("INSERT INTO dismissals (user_id, type, at) VALUES (?, ?, ?)").run(
    userId,
    type,
    (now instanceof Date ? now : new Date(now)).toISOString(),
  );
}
