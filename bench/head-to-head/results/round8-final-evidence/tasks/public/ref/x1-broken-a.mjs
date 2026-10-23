// Broken A for X1 notify. Standalone, same storage as the good reference. Three plausible mistakes:
// 1. The local day is the UTC calendar date, so the cap resets at UTC midnight, not at the user's local midnight.
// 2. Quiet hours use a fixed UTC+3 offset for every user instead of the user's own time zone.
// 3. The cap unit is kept when every channel failed (the reservation is never released).
// Expected FAILS: 2 (New York quiet-hour edges), 3 (UTC-day cap: the 4th Los Angeles message at 03:00Z is allowed),
// 4 (failed notifications spend the cap, so the three later deliveries are refused).
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

export async function notify({ user, notification, now, deliver }) {
  const prefs = user.preferences ?? {};
  const allowed = notification.channels.filter((c) => prefs[c] !== false);
  if (allowed.length === 0) {
    return { delivered: false, channel: null, reason: "The user has opted out of every listed channel." };
  }
  const secure = notification.category === "security";
  const utcHour = now.getUTCHours();
  const hour = (utcHour + 3) % 24; // mistake 2: fixed UTC+3 for everyone
  if (!secure && (hour >= 22 || hour < 8)) {
    return { delivered: false, channel: null, reason: "Blocked by quiet hours (22:00 to 08:00 local time)." };
  }
  const day = now.toISOString().slice(0, 10); // mistake 1: UTC calendar date
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
      // try the next channel
    }
  }
  // mistake 3: the slot is not released here, so a failed notification keeps its cap unit
  return { delivered: false, channel: null, reason: "Delivery failed on every allowed channel." };
}
