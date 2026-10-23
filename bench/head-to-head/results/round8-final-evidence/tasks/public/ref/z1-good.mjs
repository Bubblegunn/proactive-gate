// Reference for Z1 daily check-in nudge. Standalone: node builtins only (node:sqlite on Node 22+).
// Rules, in the order decide applies them:
//   1. flags.proactiveEnabled must be true, read on every call (kill switch at decision time).
//   2. An opt-out row for (user, type) refuses. Opt-outs are rows in SQLite, so they survive restarts.
//   3. Three or more recorded dismissals of the type refuse. Dismissals are counted per type, never shared.
//   4. consents.marketing must be boolean true (promotion needs explicit opt-in). Missing consents means not sent.
//   5. The zone is deviceTimezone first, then timezone when it is not the "UTC" placeholder. An unusable or
//      missing zone refuses, so no push leaves at night on a guess.
//   6. Local hour must be 08:00 to 20:59. Checked with Intl in the resolved zone.
//   7. A check-in is capped at one per user per local calendar day. The count and the insert happen in one
//      BEGIN IMMEDIATE transaction, so 24 concurrent calls across two processes send once.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const CHECKIN_DAILY_CAP = 1;
const DISMISS_LIMIT = 3;
const HOUR_FROM = 8;
const HOUR_TO = 21;

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
    const db = new DatabaseSync(join(dir, "z1.db"));
    db.exec("PRAGMA busy_timeout = 60000");
    retryBusy(() => db.exec("PRAGMA journal_mode = WAL"));
    retryBusy(() =>
      db.exec(
        "CREATE TABLE IF NOT EXISTS optouts (user_id TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (user_id, type));" +
          "CREATE TABLE IF NOT EXISTS dismissals (user_id TEXT NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL);" +
          "CREATE TABLE IF NOT EXISTS sends (user_id TEXT NOT NULL, type TEXT NOT NULL, day TEXT NOT NULL, at TEXT NOT NULL);",
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
function localParts(date, zone) {
  if (!fmtCache.has(zone)) {
    fmtCache.set(
      zone,
      new Intl.DateTimeFormat("en-CA", {
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
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
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

// deviceTimezone ranks first; the sign-up zone counts only when it is a real zone and not the "UTC" placeholder.
function usableZone(user) {
  return validZone(user.deviceTimezone) ?? (user.timezone === "UTC" ? null : validZone(user.timezone));
}

const refuse = (reason) => ({ send: false, reason });

export async function decide({ user, candidate, now, flags }) {
  if (!flags || flags.proactiveEnabled !== true) return refuse("Proactive messages are switched off right now.");
  const db = open();
  const type = candidate.type;

  if (db.prepare("SELECT 1 AS x FROM optouts WHERE user_id = ? AND type = ?").get(user.id, type)) {
    return refuse("The user switched this kind of notification off.");
  }
  const dismissed = db
    .prepare("SELECT COUNT(*) AS n FROM dismissals WHERE user_id = ? AND type = ?")
    .get(user.id, type).n;
  if (dismissed >= DISMISS_LIMIT) {
    return refuse("The user dismissed this kind of notification several times, so it is paused.");
  }

  const consents = user.consents && typeof user.consents === "object" ? user.consents : {};
  if (consents.marketing !== true) return refuse("The user has not agreed to receive marketing messages.");

  const zone = usableZone(user);
  if (!zone) return refuse("No usable time zone is known for this user, so nothing is sent.");
  const local = localParts(now, zone);
  if (local.hour < HOUR_FROM || local.hour >= HOUR_TO) {
    return refuse("It is outside the 08:00 to 21:00 window in the user's local time.");
  }

  return tx(db, () => {
    if (type === "checkin") {
      const used = db
        .prepare("SELECT COUNT(*) AS n FROM sends WHERE user_id = ? AND type = 'checkin' AND day = ?")
        .get(user.id, local.day).n;
      if (used >= CHECKIN_DAILY_CAP) return refuse("The daily check-in was already sent today for this user.");
    }
    db.prepare("INSERT INTO sends (user_id, type, day, at) VALUES (?, ?, ?, ?)").run(
      user.id,
      type,
      local.day,
      now.toISOString(),
    );
    return { send: true, reason: null };
  });
}

export async function recordDismissal(userId, type, now) {
  const db = open();
  db.prepare("INSERT INTO dismissals (user_id, type, at) VALUES (?, ?, ?)").run(
    userId,
    type,
    (now instanceof Date ? now : new Date(now)).toISOString(),
  );
}

export async function optOut(userId, type) {
  const db = open();
  db.prepare("INSERT OR IGNORE INTO optouts (user_id, type) VALUES (?, ?)").run(userId, type);
}
