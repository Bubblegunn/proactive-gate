// Reference for H3 STOP keywords, START, snooze and consent. Standalone: node builtins only (node:sqlite, Node 22+).
// A keyword is the whole message after trimming, lower-casing and removing trailing punctuation.
// State: STATE_DIR/prefs.sqlite. One row per (user, channel) opt-out; one row per user snooze.
// Each statement is a single write, so concurrent processes cannot lose each other's updates.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const START_WORDS = new Set(["start", "unstop", "yes"]);

function open() {
  const dir = process.env.STATE_DIR;
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "prefs.sqlite"));
  db.exec(`PRAGMA busy_timeout = 20000;
    CREATE TABLE IF NOT EXISTS optout (user TEXT NOT NULL, channel TEXT NOT NULL, PRIMARY KEY (user, channel));
    CREATE TABLE IF NOT EXISTS snooze (user TEXT PRIMARY KEY, until INTEGER NOT NULL);`);
  return db;
}

const keyword = (text) => String(text).trim().toLowerCase().replace(/[\p{P}\p{S}\s]+$/u, "");

export async function handleInbound({ userId, channel, text }) {
  const db = open();
  try {
    const w = keyword(text);
    if (STOP_WORDS.has(w)) {
      db.prepare("INSERT OR IGNORE INTO optout (user, channel) VALUES (?, ?)").run(userId, channel);
    } else if (START_WORDS.has(w)) {
      db.prepare("DELETE FROM optout WHERE user = ? AND channel = ?").run(userId, channel);
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
    if (db.prepare("SELECT 1 AS hit FROM optout WHERE user = ? AND channel = ?").get(user.id, channel)) {
      return { sent: false, reason: "The customer replied stop on this channel, so no reminder was sent here." };
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
