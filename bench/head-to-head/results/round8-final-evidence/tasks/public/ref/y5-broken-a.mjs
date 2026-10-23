// Broken A for Y5. Mistake 1: the memory store keeps its counts in a module-level Map, so every memory sender in one
// process shares them and a new sender does not start empty. Mistake 2: the sqlite store reads the count, waits a tick
// and only then writes, with no transaction, so two processes that read at the same time both take the last slot.
// Expected FAILS: 2 (a second memory sender is refused by the first one's counts; a new sender is not empty), 4
// (without a transaction and busy timeout, concurrent processes fail with "database is locked" or send more than 3 per
// user). Equivalence and sharing within one process still hold.
import { DatabaseSync } from "node:sqlite";

const CAP = 3;
const shared = new Map();

const fmts = new Map();
function dayOf(date, timeZone) {
  if (!fmts.has(timeZone)) {
    fmts.set(timeZone, new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }));
  }
  const p = {};
  for (const x of fmts.get(timeZone).formatToParts(date)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}

function memorySender() {
  return {
    async trySend({ user, now }) {
      const key = `${user.id}|${dayOf(now, user.timezone)}`;
      const n = shared.get(key) ?? 0;
      if (n >= CAP) return { sent: false };
      shared.set(key, n + 1);
      return { sent: true };
    },
  };
}

function sqliteSender(path) {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE IF NOT EXISTS sends (user_id TEXT NOT NULL, day TEXT NOT NULL, at_ms INTEGER NOT NULL)");
  return {
    async trySend({ user, now }) {
      const day = dayOf(now, user.timezone);
      const n = db.prepare("SELECT COUNT(*) AS n FROM sends WHERE user_id = ? AND day = ?").get(user.id, day).n;
      await new Promise((resolve) => setTimeout(resolve, 2));
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
    return sqliteSender(config.path);
  }
  throw new Error(`store must be "memory" or "sqlite", got ${JSON.stringify(store)}`);
}
