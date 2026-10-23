// Reference for Z3 morning briefing push. Standalone: node builtins only (node:sqlite on Node 22+), state in STATE_DIR.
// deliver applies, in order:
//   1. snoozedUntil: while now is before it (the end is exclusive) both surfaces are held; resumeAt is the snooze end.
//   2. categories[type] === false holds both surfaces. A categories object without the type, or no categories at all,
//      means the user was never asked: the item stays in the app and nothing is preselected.
//   3. The push is withheld (the in-app item is still produced) unless all of these hold:
//      - categories[type] === true;
//      - fewer than three dismissals of this type are recorded (counted per type);
//      - not (platform "android" and notificationsPermitted false);
//      - consentStore.get resolves and consents.push === true (a throw or a missing answer withholds the push);
//      - today's push allowance is free. A reservation row is inserted before transport.push and deleted when the
//        phone does not accept it, so only a confirmed send spends the day's one push.
//   4. transport.inApp is always called (a stored in-app item is reported as inApp true).
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
    db.prepare("SELECT COUNT(*) AS n FROM dismissals WHERE user_id = ? AND type = ?").get(user.id, type).n >= DISMISS_LIMIT
  ) {
    pushReason = "The user dismissed this kind of notification several times, so it stays in the app.";
  } else if (user.platform === "android" && user.notificationsPermitted === false) {
    pushReason = "Notification permission is off on this Android phone, so no push is sent.";
  }

  if (!pushReason) {
    let consents = null;
    try {
      consents = await consentStore.get(user.id);
    } catch {
      consents = null;
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
        db.prepare("DELETE FROM pushes WHERE id = ?").run(reservation);
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
