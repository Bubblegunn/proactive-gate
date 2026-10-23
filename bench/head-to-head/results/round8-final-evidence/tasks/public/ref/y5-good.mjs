// Reference for Y5 createSender(config) -> { trySend }. Standalone: node builtins only (node:sqlite on Node 22+).
// Both stores keep one count per (user, local calendar day) and send while the count is below 3. The day comes from
// Intl.DateTimeFormat in the user's zone, so 4 hours of New York DST on 8 March make a 23-hour day, and midnight is local.
// The sqlite store checks and inserts inside one BEGIN IMMEDIATE transaction, so processes sharing the file cannot both
// take the last slot. Busy errors are retried. Refused calls write nothing.
import { DatabaseSync } from "node:sqlite";

const CAP = 3;

const fmts = new Map();
function dayOf(date, timeZone) {
  if (!fmts.has(timeZone)) {
    fmts.set(timeZone, new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }));
  }
  const p = {};
  for (const x of fmts.get(timeZone).formatToParts(date)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}

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

function memorySender() {
  const counts = new Map();
  return {
    async trySend({ user, now }) {
      const key = `${user.id}|${dayOf(now, user.timezone)}`;
      const n = counts.get(key) ?? 0;
      if (n >= CAP) return { sent: false };
      counts.set(key, n + 1);
      return { sent: true };
    },
  };
}

function sqliteSender(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 60000");
  retryBusy(() => db.exec("PRAGMA journal_mode = WAL"));
  retryBusy(() =>
    db.exec("CREATE TABLE IF NOT EXISTS sends (user_id TEXT NOT NULL, day TEXT NOT NULL, at_ms INTEGER NOT NULL)"),
  );
  return {
    async trySend({ user, now }) {
      const day = dayOf(now, user.timezone);
      let sent = false;
      retryBusy(() => db.exec("BEGIN IMMEDIATE"));
      try {
        const n = db.prepare("SELECT COUNT(*) AS n FROM sends WHERE user_id = ? AND day = ?").get(user.id, day).n;
        if (n < CAP) {
          db.prepare("INSERT INTO sends (user_id, day, at_ms) VALUES (?, ?, ?)").run(user.id, day, now.getTime());
          sent = true;
        }
        retryBusy(() => db.exec("COMMIT"));
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // no transaction was open
        }
        throw e;
      }
      return { sent };
    },
  };
}

export function createSender(config) {
  const store = config && config.store;
  if (store === "memory") return memorySender();
  if (store === "sqlite") {
    if (typeof config.path !== "string" || config.path === "") throw new Error("store sqlite needs a path");
    return sqliteSender(config.path);
  }
  throw new Error(`store must be "memory" or "sqlite", got ${JSON.stringify(store)}`);
}
