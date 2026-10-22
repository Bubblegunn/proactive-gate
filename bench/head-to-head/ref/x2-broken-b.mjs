// Broken B for X2 guardedSend and verifyAudit. Standalone. The chain itself is written correctly (seq, link, hash).
// Three plausible mistakes:
// 1. The daily cap counts per UTC calendar day, not per local day.
// 2. New York quiet hours use a fixed UTC-5 offset (no daylight saving); other zones are correct.
// 3. verifyAudit checks only that each record's hash matches its own content. It does not check seq or the link
//    to the previous record, so a deleted or reordered line is not detected.
// Expected FAILS: 1 (New York DST edges in criterion 1; Los Angeles 20:30 PDT sixth message allowed under UTC day),
// 4 (deleted middle line and swapped lines are reported ok, so verifyAudit checks neither seq nor link).
import { createHash } from "node:crypto";
import { openSync, closeSync, readFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const ZEROS = "0".repeat(64);
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));

function withLock(stateDir, fn) {
  mkdirSync(stateDir, { recursive: true });
  const lock = join(stateDir, "audit.lock");
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      Atomics.wait(sleepBuf, 0, 0, 1 + Math.floor(Math.random() * 4));
    }
  }
  try {
    return fn();
  } finally {
    unlinkSync(lock);
  }
}

function localParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function hashOf(rec) {
  const body = { seq: rec.seq, at: rec.at, agentId: rec.agentId, userId: rec.userId, messageId: rec.messageId, decision: rec.decision, reason: rec.reason, prevHash: rec.prevHash };
  return createHash("sha256").update(rec.prevHash + JSON.stringify(body)).digest("hex");
}

const auditFile = () => join(process.env.STATE_DIR, "audit.jsonl");
function readRecords() {
  const file = auditFile();
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

export async function guardedSend({ agentId, user, message, now, send }) {
  const decision = withLock(process.env.STATE_DIR, () => {
    const records = readRecords();
    const prevHash = records.length ? records[records.length - 1].hash : ZEROS;
    let reason = null;
    if (user.optedOut) reason = "The user has opted out of messages.";
    else {
      const local = localParts(now, user.timezone);
      // mistake 2: New York is UTC-5 all year
      const hour = user.timezone === "America/New_York" ? (now.getUTCHours() + 19) % 24 : local.hour;
      if (hour >= 21 || hour < 8) reason = "Blocked by quiet hours (21:00 to 08:00 local time).";
      else {
        // mistake 1: the day is the UTC calendar date
        const day = now.toISOString().slice(0, 10);
        const sent = records.filter((r) => r.decision === "allowed" && r.agentId === agentId && r.userId === user.id && r.at.slice(0, 10) === day).length;
        if (sent >= 5) reason = "Blocked by the daily cap of 5 messages for this agent and user.";
      }
    }
    const rec = { seq: records.length + 1, at: now.toISOString(), agentId, userId: user.id, messageId: message.id, decision: reason === null ? "allowed" : "blocked", reason, prevHash };
    rec.hash = hashOf(rec);
    appendFileSync(auditFile(), JSON.stringify(rec) + "\n");
    return { allowed: reason === null, reason };
  });
  if (!decision.allowed) return { sent: false, reason: decision.reason };
  await send();
  return { sent: true, reason: null };
}

// mistake 3: only the hash of each record is checked against its own content
export async function verifyAudit() {
  const file = auditFile();
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0) : [];
  for (let i = 0; i < lines.length; i++) {
    const rec = JSON.parse(lines[i]);
    if (rec.hash !== hashOf(rec)) return { ok: false, brokenAt: i + 1 };
  }
  return { ok: true, records: lines.length };
}
