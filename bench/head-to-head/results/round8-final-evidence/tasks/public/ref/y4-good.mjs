// Reference for Y4 deliver and whyNothing. Standalone: node builtins only (node:sqlite on Node 22+).
// State is one SQLite file in STATE_DIR. Each deliver call decides and records inside one BEGIN IMMEDIATE
// transaction, so the daily count it reads is the committed count from every process, and a blocked call is
// recorded too. Busy errors are retried. Local day and clock come from Intl.DateTimeFormat in the user's zone.
// Order of rules: consent, then quiet hours (22:00 to 07:00, start inclusive, end exclusive), then daily cap of 2.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const CAP = 2;
const REASON = {
  consent: "The user has not given consent.",
  quietHours: "The message falls within quiet hours (22:00 to 07:00 local time).",
  dailyCap: "The daily limit of 2 delivered messages for this local day has been reached.",
};
const PHRASE = { consent: "consent", quietHours: "quiet hours", dailyCap: "daily limit" };

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
    const db = new DatabaseSync(join(dir, "records.db"));
    db.exec("PRAGMA busy_timeout = 60000");
    retryBusy(() => db.exec("PRAGMA journal_mode = WAL"));
    retryBusy(() =>
      db.exec(
        "CREATE TABLE IF NOT EXISTS records (seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, message_id TEXT NOT NULL, at_ms INTEGER NOT NULL, day TEXT NOT NULL, delivered INTEGER NOT NULL, rule TEXT)",
      ),
    );
    handles.set(dir, db);
  }
  return handles.get(dir);
}

const fmts = new Map();
function local(date, timeZone) {
  if (!fmts.has(timeZone)) {
    fmts.set(
      timeZone,
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
    );
  }
  const p = {};
  for (const x of fmts.get(timeZone).formatToParts(date)) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}

// 22:00 (1320) inclusive up to 07:00 (420) exclusive, across midnight.
const inQuiet = (minute) => minute >= 22 * 60 || minute < 7 * 60;

export async function deliver({ user, message, now }) {
  const db = open();
  const at = new Date(now);
  const { day, minute } = local(at, user.timezone);
  let rule = null;
  retryBusy(() => db.exec("BEGIN IMMEDIATE"));
  try {
    if (!user.consent) rule = "consent";
    else if (inQuiet(minute)) rule = "quietHours";
    else {
      const n = db
        .prepare("SELECT COUNT(*) AS n FROM records WHERE user_id = ? AND day = ? AND delivered = 1")
        .get(user.id, day).n;
      if (n >= CAP) rule = "dailyCap";
    }
    db.prepare(
      "INSERT INTO records (user_id, message_id, at_ms, day, delivered, rule) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(user.id, message.id, at.getTime(), day, rule === null ? 1 : 0, rule);
    retryBusy(() => db.exec("COMMIT"));
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // no transaction was open
    }
    throw e;
  }
  return { delivered: rule === null, rule };
}

export async function whyNothing({ userId, from, to }) {
  const db = open();
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const rows = retryBusy(() =>
    db
      .prepare(
        "SELECT message_id, at_ms, delivered, rule FROM records WHERE user_id = ? AND at_ms >= ? AND at_ms < ? ORDER BY at_ms, seq",
      )
      .all(userId, fromMs, toMs),
  );
  let delivered = 0;
  const blocked = [];
  const byRule = {};
  for (const row of rows) {
    if (row.delivered === 1) {
      delivered++;
      continue;
    }
    blocked.push({
      messageId: row.message_id,
      at: new Date(row.at_ms).toISOString(),
      rule: row.rule,
      reason: REASON[row.rule],
    });
    byRule[row.rule] = (byRule[row.rule] ?? 0) + 1;
  }
  let verdict;
  if (rows.length === 0) {
    verdict = "There were no messages for this user in this range.";
  } else if (delivered === 0) {
    const top = Object.entries(byRule).sort((a, b) => b[1] - a[1])[0][0];
    verdict = `Nothing was delivered: ${blocked.length} messages were blocked, most of them by ${PHRASE[top]}.`;
  } else {
    verdict = `${delivered} messages were delivered in this range.`;
  }
  return { delivered, blocked, byRule, verdict };
}
