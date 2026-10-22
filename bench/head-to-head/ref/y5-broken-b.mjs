// Broken B for Y5. Mistake 1: the sqlite path is ignored; every sqlite sender opens a private in-memory database, so
// state is not shared between senders or processes and does not survive a restart. Mistake 2: the day is the UTC
// calendar date for both stores, so the count resets at 00:00 UTC (03:00 in Istanbul, 20:00 in New York) and not at
// local midnight. The store checks and the day key are otherwise right.
// Expected FAILS: 1 (the Istanbul and New York days do not match the reference), 3 (no sharing and no restart), 4
// (each process has its own count, so more than 3 are sent per user), 5 (the local day boundaries are wrong).
import { DatabaseSync } from "node:sqlite";

const CAP = 3;

function dayOf(date) {
  return date.toISOString().slice(0, 10);
}

function memorySender() {
  const counts = new Map();
  return {
    async trySend({ user, now }) {
      const key = `${user.id}|${dayOf(now)}`;
      const n = counts.get(key) ?? 0;
      if (n >= CAP) return { sent: false };
      counts.set(key, n + 1);
      return { sent: true };
    },
  };
}

function sqliteSender() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE IF NOT EXISTS sends (user_id TEXT NOT NULL, day TEXT NOT NULL, at_ms INTEGER NOT NULL)");
  return {
    async trySend({ user, now }) {
      const day = dayOf(now);
      const n = db.prepare("SELECT COUNT(*) AS n FROM sends WHERE user_id = ? AND day = ?").get(user.id, day).n;
      if (n >= CAP) return { sent: false };
      db.prepare("INSERT INTO sends (user_id, day, at_ms) VALUES (?, ?, ?)").run(user.id, day, now.getTime());
      return { sent: true };
    },
  };
}

export function createSender(config) {
  const store = config && config.store;
  if (store === "memory") return memorySender();
  if (store === "sqlite") {
    if (typeof config.path !== "string" || config.path === "") throw new Error("store sqlite needs a path");
    return sqliteSender();
  }
  throw new Error(`store must be "memory" or "sqlite", got ${JSON.stringify(store)}`);
}
