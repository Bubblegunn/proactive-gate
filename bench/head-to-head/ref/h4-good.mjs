// Reference for H4 deliver. Standalone: node builtins only (node:sqlite on Node 22+).
// Every deliver call does its check and reservation in one BEGIN IMMEDIATE transaction. The (user, event)
// row is inserted before send, so a crash inside send leaves the row behind: the event stays "already
// delivered" and still counts against that day's cap. WAL mode and a 60 s busy timeout let 50 processes share
// the file. The day key is the user's local calendar date from Intl.DateTimeFormat. Busy errors are retried (retryBusy).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const CAP = 5;
// SQLite can still report SQLITE_BUSY under 50-way contention (busy_timeout does not cover every path, e.g. the
// journal-mode switch and BEGIN IMMEDIATE), so busy errors are retried with a short synchronous sleep.
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
    const db = new DatabaseSync(join(dir, "deliver.db"));
    db.exec("PRAGMA busy_timeout = 60000");
    retryBusy(() => db.exec("PRAGMA journal_mode = WAL"));
    retryBusy(() =>
      db.exec(
        "CREATE TABLE IF NOT EXISTS deliveries (user_id TEXT NOT NULL, event_id TEXT NOT NULL, day TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY (user_id, event_id))",
      ),
    );
    handles.set(dir, db);
  }
  return handles.get(dir);
}

function localDay(date, timeZone) {
  const parts = {};
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export async function deliver({ user, eventId, now, send }) {
  const db = open();
  const day = localDay(now, user.timezone);
  let refusal = null;
  retryBusy(() => db.exec("BEGIN IMMEDIATE"));
  try {
    const seen = db.prepare("SELECT 1 AS x FROM deliveries WHERE user_id = ? AND event_id = ?").get(user.id, eventId);
    if (seen) {
      refusal = { sent: false, reason: "This event was already delivered to this user." };
    } else {
      const used = db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE user_id = ? AND day = ?").get(user.id, day).n;
      if (used >= CAP) {
        refusal = { sent: false, reason: "The daily cap of 5 notifications for this user is reached." };
      } else {
        db.prepare("INSERT INTO deliveries (user_id, event_id, day, status) VALUES (?, ?, ?, 'pending')").run(
          user.id,
          eventId,
          day,
        );
      }
    }
    retryBusy(() => db.exec("COMMIT"));
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  if (refusal) return refusal;

  await send();
  retryBusy(() =>
    db.prepare("UPDATE deliveries SET status = 'sent' WHERE user_id = ? AND event_id = ?").run(user.id, eventId),
  );
  return { sent: true, reason: null };
}
