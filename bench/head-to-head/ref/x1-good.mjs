// Reference for X1 notify. Standalone: node builtins only (node:sqlite on Node 22+).
// Order of checks: every listed channel switched off -> "opted out"; then quiet hours (non-security only,
// 22:00 to 08:00 local, end exclusive); then the cap (non-security, 3 per user per local calendar day).
// The cap unit is reserved in a BEGIN IMMEDIATE transaction before any channel is tried, and released again when
// every allowed channel threw, so a notification that reached no channel does not use up the day.
// Channels are tried in list order; a throw moves on to the next allowed channel.
// All worker processes share STATE_DIR/notify.db (WAL, busy_timeout, bounded retry on SQLITE_BUSY).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const CAP = 3;
const QUIET_FROM = 22;
const QUIET_TO = 8;

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
    const db = new DatabaseSync(join(dir, "notify.db"));
    db.exec("PRAGMA busy_timeout = 60000");
    retryBusy(() => db.exec("PRAGMA journal_mode = WAL"));
    retryBusy(() =>
      db.exec("CREATE TABLE IF NOT EXISTS uses (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, day TEXT NOT NULL)"),
    );
    handles.set(dir, db);
  }
  return handles.get(dir);
}

// Local calendar day and local hour (0 to 23) of an instant in the given IANA zone.
function localParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

const isQuiet = (hour) => hour >= QUIET_FROM || hour < QUIET_TO;

export async function notify({ user, notification, now, deliver }) {
  const prefs = user.preferences ?? {};
  const allowed = notification.channels.filter((c) => prefs[c] !== false);
  if (allowed.length === 0) {
    return { delivered: false, channel: null, reason: "The user has opted out of every listed channel." };
  }

  const secure = notification.category === "security";
  const { day, hour } = localParts(now, user.timezone);
  if (!secure && isQuiet(hour)) {
    return { delivered: false, channel: null, reason: "Blocked by quiet hours (22:00 to 08:00 local time)." };
  }

  let slot = null;
  if (!secure) {
    const db = open();
    let refused = false;
    retryBusy(() => db.exec("BEGIN IMMEDIATE"));
    try {
      const used = db.prepare("SELECT COUNT(*) AS n FROM uses WHERE user_id = ? AND day = ?").get(user.id, day).n;
      if (used >= CAP) refused = true;
      else slot = Number(db.prepare("INSERT INTO uses (user_id, day) VALUES (?, ?)").run(user.id, day).lastInsertRowid);
      retryBusy(() => db.exec("COMMIT"));
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    if (refused) {
      return { delivered: false, channel: null, reason: `Blocked by the daily cap of ${CAP} notifications for this user.` };
    }
  }

  for (const channel of allowed) {
    try {
      await deliver(channel);
      return { delivered: true, channel, reason: null };
    } catch {
      // try the next allowed channel
    }
  }

  if (slot !== null) {
    const db = open();
    retryBusy(() => db.prepare("DELETE FROM uses WHERE id = ?").run(slot));
  }
  return { delivered: false, channel: null, reason: "Delivery failed on every allowed channel." };
}
