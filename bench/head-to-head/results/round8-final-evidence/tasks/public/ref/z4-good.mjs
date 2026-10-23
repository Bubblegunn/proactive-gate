// Reference for Z4 ready notices and suggestions. Standalone: node builtins only (node:sqlite on Node 22+), state in STATE_DIR.
// decide applies, in order:
//   1. quiet hours: local hour 22:00 to 07:59 holds every origin (the end 08:00 is allowed).
//   2. new-account hold: an "inferred" suggestion is held while the account (createdAt, not profileCreatedAt) is younger
//      than 7 days. "requested" and "reminder" pass this hold.
//   3. daily nudge cap: an "inferred" suggestion is refused when config.dailyNudgeCap inferred suggestions were already
//      sent on the same local day. Only sends are counted, and the count is written in the same transaction as the send.
//   Reminders and requested notices are never counted against the cap.
// Every refusal carries a reasonCode from REASON_CODES.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const REASON_CODES = ["QUIET_HOURS", "NEW_ACCOUNT_HOLD", "DAILY_NUDGE_CAP"];

const DAY_MS = 24 * 60 * 60 * 1000;
const NEW_ACCOUNT_MS = 7 * DAY_MS;
const DEFAULT_CAP = 2;

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
    const db = new DatabaseSync(join(dir, "z4.db"));
    db.exec("PRAGMA busy_timeout = 60000");
    retryBusy(() => db.exec("PRAGMA journal_mode = WAL"));
    retryBusy(() =>
      db.exec(
        "CREATE TABLE IF NOT EXISTS nudges (user_id TEXT NOT NULL, day TEXT NOT NULL, origin TEXT NOT NULL);",
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

const fmtCache = new Map();
function localParts(zone, date) {
  if (!fmtCache.has(zone)) {
    fmtCache.set(
      zone,
      new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        hourCycle: "h23",
      }),
    );
  }
  const p = {};
  for (const part of fmtCache.get(zone).formatToParts(date)) p[part.type] = part.value;
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}

function refuse(reasonCode) {
  return { send: false, reasonCode };
}

export async function decide({ user, candidate, now, config }) {
  const { day, hour } = localParts(user.timezone, now);
  if (hour >= 22 || hour < 8) return refuse("QUIET_HOURS");

  if (candidate.origin === "inferred") {
    const age = now.getTime() - Date.parse(user.createdAt);
    if (age < NEW_ACCOUNT_MS) return refuse("NEW_ACCOUNT_HOLD");
  }

  if (candidate.origin !== "inferred") return { send: true };

  const cap = Number.isFinite(config && config.dailyNudgeCap) ? config.dailyNudgeCap : DEFAULT_CAP;
  const db = open();
  return tx(db, () => {
    const { n } = db
      .prepare("SELECT COUNT(*) AS n FROM nudges WHERE user_id = ? AND day = ? AND origin = 'inferred'")
      .get(user.id, day);
    if (n >= cap) return refuse("DAILY_NUDGE_CAP");
    db.prepare("INSERT INTO nudges (user_id, day, origin) VALUES (?, ?, 'inferred')").run(user.id, day);
    return { send: true };
  });
}
