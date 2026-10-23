// Reference for Z2 weekly digest text. Standalone: node builtins only (node:sqlite on Node 22+), state in STATE_DIR.
// trySend applies, in order:
//   1. An opt-out row for (user, channel) refuses. Opt-outs are rows in SQLite and survive restarts.
//   2. A digest whose createdAt is more than six hours before now is dropped (stale redelivery).
//   3. The recipient-local time must be 08:00 up to 21:00 (minutes 480 to 1259 of the local day), read with Intl.
//   4. Dedupe: one row per (user, message.id), inserted in the same BEGIN IMMEDIATE transaction that checks it,
//      so redelivery or a crash-and-retry across processes sends at most once.
// handleInbound treats a message as a revocation only when its normalised text is exactly one keyword:
// trimmed, lower-cased, surrounding punctuation removed, inner spaces collapsed.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const WINDOW_FROM = 8 * 60;
const WINDOW_TO = 21 * 60;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const KEYWORDS = new Set(["stop", "quit", "end", "revoke", "opt out", "cancel", "unsubscribe"]);

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
    const db = new DatabaseSync(join(dir, "z2.db"));
    db.exec("PRAGMA busy_timeout = 60000");
    retryBusy(() => db.exec("PRAGMA journal_mode = WAL"));
    retryBusy(() =>
      db.exec(
        "CREATE TABLE IF NOT EXISTS optouts (user_id TEXT NOT NULL, channel TEXT NOT NULL, PRIMARY KEY (user_id, channel));" +
          "CREATE TABLE IF NOT EXISTS digests (user_id TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY (user_id, message_id));",
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

function validZone(z) {
  if (typeof z !== "string" || z.length === 0) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return z;
  } catch {
    return null;
  }
}

const fmtCache = new Map();
function localMinute(date, zone) {
  if (!fmtCache.has(zone)) {
    fmtCache.set(
      zone,
      new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
    );
  }
  const p = {};
  for (const part of fmtCache.get(zone).formatToParts(date)) p[part.type] = part.value;
  return Number(p.hour) * 60 + Number(p.minute);
}

const normalise = (text) =>
  String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}]+$/u, "")
    .replace(/\s+/g, " ");

const refuse = (reason) => ({ sent: false, reason });

export async function trySend({ user, message, now }) {
  const db = open();
  if (db.prepare("SELECT 1 AS x FROM optouts WHERE user_id = ? AND channel = ?").get(user.id, message.channel)) {
    return refuse("The customer has turned off digest texts.");
  }
  const created = Date.parse(message.createdAt);
  const nowMs = now.getTime();
  if (!Number.isFinite(created) || nowMs - created > MAX_AGE_MS) {
    return refuse("This digest is more than six hours old, so it is dropped.");
  }
  const zone = validZone(user.timezone);
  if (!zone) return refuse("No valid time zone is known for this customer, so nothing is sent.");
  const minute = localMinute(now, zone);
  if (minute < WINDOW_FROM || minute >= WINDOW_TO) {
    return refuse("Digests go out only between 08:00 and 21:00 in the customer's local time.");
  }
  return tx(db, () => {
    if (db.prepare("SELECT 1 AS x FROM digests WHERE user_id = ? AND message_id = ?").get(user.id, message.id)) {
      return refuse("This digest was already sent to this customer.");
    }
    db.prepare("INSERT INTO digests (user_id, message_id) VALUES (?, ?)").run(user.id, message.id);
    return { sent: true, reason: null };
  });
}

export async function handleInbound({ userId, channel, text }) {
  if (!KEYWORDS.has(normalise(text))) return { revoked: false };
  const db = open();
  db.prepare("INSERT OR IGNORE INTO optouts (user_id, channel) VALUES (?, ?)").run(userId, channel);
  return { revoked: true };
}

export async function optOut(userId, channel) {
  const db = open();
  db.prepare("INSERT OR IGNORE INTO optouts (user_id, channel) VALUES (?, ?)").run(userId, channel);
}
