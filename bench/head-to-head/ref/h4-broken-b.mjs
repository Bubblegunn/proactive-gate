// Broken B for H4. Mistake 1: no per-event idempotency, so a repeated eventId is counted and sent again.
// Mistake 2: the day that counts is the UTC calendar date, so the budget resets at UTC midnight (03:00 local
// in Istanbul) and does not reset at the user's local midnight. The cap itself is enforced correctly with a
// BEGIN IMMEDIATE transaction and a row written before send.
// Expected FAILS: 2 (no idempotency: ten redeliveries send), 3 (redelivery sends again), 4 (redelivery after a
// crash sends again), 6 (user m is refused at 21:00Z because the UTC date is still the same day).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

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
    const db = new DatabaseSync(join(dir, "broken-b.db"));
    db.exec("PRAGMA busy_timeout = 60000");
    retryBusy(() => db.exec("PRAGMA journal_mode = WAL"));
    retryBusy(() => db.exec("CREATE TABLE IF NOT EXISTS sends (user_id TEXT NOT NULL, day TEXT NOT NULL)"));
    handles.set(dir, db);
  }
  return handles.get(dir);
}

export async function deliver({ user, eventId, now, send }) {
  const db = open();
  const utcDay = now.toISOString().slice(0, 10);
  retryBusy(() => db.exec("BEGIN IMMEDIATE"));
  let used;
  try {
    used = db.prepare("SELECT COUNT(*) AS n FROM sends WHERE user_id = ? AND day = ?").get(user.id, utcDay).n;
    if (used < 5) db.prepare("INSERT INTO sends (user_id, day) VALUES (?, ?)").run(user.id, utcDay);
    retryBusy(() => db.exec("COMMIT"));
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  if (used >= 5) return { sent: false, reason: "The daily cap of 5 notifications for this user is reached." };
  await send();
  return { sent: true, reason: null };
}
