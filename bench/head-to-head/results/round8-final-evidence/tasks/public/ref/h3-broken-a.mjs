// Broken A for H3: the opt-out is kept per user, not per channel, and keywords are matched with String#includes.
// Expected FAILS: 2 (a stop on sms also silences email and push, and the reverse), 3 (ordinary texts that merely
// contain a keyword, such as "please stop by tomorrow", "stop it", "stopping", "end of month", stop the user),
// 4 (a START or "yes please" on one channel re-enables all channels; "unstop" contains "stop" and is read as STOP).
// Expected PASSES: 1 (every spelling contains a keyword), 5 (state is persistent), 6 (snooze and consent are correct).
// Standalone: node builtins only (node:sqlite on Node 22+).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const STOP_WORDS = ["stop", "unsubscribe", "cancel", "end", "quit"];
const START_WORDS = ["start", "unstop", "yes"];

function open() {
  const dir = process.env.STATE_DIR;
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "prefs.sqlite"));
  db.exec(`PRAGMA busy_timeout = 20000;
    CREATE TABLE IF NOT EXISTS optout (user TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS snooze (user TEXT PRIMARY KEY, until INTEGER NOT NULL);`);
  return db;
}

export async function handleInbound({ userId, text }) {
  const db = open();
  try {
    const t = String(text).toLowerCase();
    if (STOP_WORDS.some((w) => t.includes(w))) {
      db.prepare("INSERT OR IGNORE INTO optout (user) VALUES (?)").run(userId);
    } else if (START_WORDS.some((w) => t.includes(w))) {
      db.prepare("DELETE FROM optout WHERE user = ?").run(userId);
    }
  } finally {
    db.close();
  }
}

export async function snooze({ userId, until }) {
  const db = open();
  try {
    db.prepare("INSERT INTO snooze (user, until) VALUES (?, ?) ON CONFLICT(user) DO UPDATE SET until = excluded.until")
      .run(userId, until.getTime());
  } finally {
    db.close();
  }
}

export async function trySend({ user, channel, now }) {
  const db = open();
  try {
    if (user.consent !== true) {
      return { sent: false, reason: "The customer has not given consent to receive messages, so nothing was sent." };
    }
    if (db.prepare("SELECT 1 AS hit FROM optout WHERE user = ?").get(user.id)) {
      return { sent: false, reason: "The customer replied stop, so no reminder was sent." };
    }
    const row = db.prepare("SELECT until FROM snooze WHERE user = ?").get(user.id);
    if (row && now.getTime() < row.until) {
      return { sent: false, reason: "Reminders are on snooze for this customer until a later time, so nothing was sent." };
    }
    return { sent: true, reason: null };
  } finally {
    db.close();
  }
}
