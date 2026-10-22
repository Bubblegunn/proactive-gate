// Reference for Z5 stay quiet (decide). Standalone: node builtins only (node:sqlite on Node 22+), state in STATE_DIR.
// decide applies, in order (the first rule that holds returns send false with a sentence as reason):
//   1. context.crisis true: nothing is shown and nothing is recorded.
//   2. thin data: accountAgeDays under 3, or dataPoints under 5.
//   3. focusMode true, or confidence under 0.5.
//   4. the same insight key was already shown on the same local day for this user.
// Otherwise it shows the insight and records (user, key, local day) in the same transaction. The surfaces come from
// hourStats at the local hour: "push" is included when the user acted at least as often as dismissed in that hour
// (or there is no history for that hour), and "inApp" is always included.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

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
    const db = new DatabaseSync(join(dir, "z5.db"));
    db.exec("PRAGMA busy_timeout = 60000");
    retryBusy(() => db.exec("PRAGMA journal_mode = WAL"));
    retryBusy(() =>
      db.exec("CREATE TABLE IF NOT EXISTS shown (user_id TEXT NOT NULL, insight_key TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY (user_id, insight_key, day));"),
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
      new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }),
    );
  }
  const p = {};
  for (const part of fmtCache.get(zone).formatToParts(date)) p[part.type] = part.value;
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}

function hold(reason) {
  return { send: false, surfaces: [], reason };
}

export async function decide({ user, candidate, context, now }) {
  if (context && context.crisis === true) {
    return hold("The assistant stays quiet while the user is in a crisis.");
  }
  const insight = candidate.insight || {};
  if (user.accountAgeDays < 3 || insight.dataPoints < 5) {
    return hold("There is not enough history yet to show this insight.");
  }
  if (user.focusMode === true) {
    return hold("The user has focus mode on.");
  }
  if (!(insight.confidence >= 0.5)) {
    return hold("The insight is not certain enough to show.");
  }

  const { day, hour } = localParts(user.timezone, now);
  const db = open();
  return tx(db, () => {
    const seen = db
      .prepare("SELECT 1 AS hit FROM shown WHERE user_id = ? AND insight_key = ? AND day = ?")
      .get(user.id, insight.key, day);
    if (seen) return hold("This insight was already shown today.");
    db.prepare("INSERT INTO shown (user_id, insight_key, day) VALUES (?, ?, ?)").run(user.id, insight.key, day);

    const stats = context && context.hourStats ? context.hourStats[String(hour)] : undefined;
    const total = stats ? (stats.acted || 0) + (stats.dismissed || 0) : 0;
    const pushOk = total === 0 || (stats.acted || 0) >= (stats.dismissed || 0);
    return { send: true, surfaces: pushOk ? ["push", "inApp"] : ["inApp"], reason: null };
  });
}
