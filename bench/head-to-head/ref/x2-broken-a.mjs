// Broken A for X2 guardedSend and verifyAudit. Standalone. Three plausible mistakes, with what each one breaks:
// 1. The hash is computed over the record with its keys in a different order (at before seq). The chain is then
//    not the documented one, although verifyAudit agrees with itself. Measured alone (the other two mistakes
//    removed, in the review) it fails criteria 3, 5 and 6. In this file its effect is masked by mistake 3,
//    because most records are missing.
// 2. The read of the last record and the append are not under a lock; an await sits between them, so concurrent
//    calls read the same last record and write duplicate seq values and forked links. This causes criterion 5
//    (seq not 1..40, and a link or hash that does not match, shown as brokenAt 2 by verifyAudit).
// 3. Blocked calls are not written to audit.jsonl, so the file holds only the allowed messages. This causes
//    criterion 1 (a blocked call has no audit record, so the audit keyword "opted out" or "quiet hours" is missing),
//    criterion 2 (one line for two calls), criterion 3 and 4 (5 records for 8 calls, so the chain and the
//    tamper cases do not run on the full file) and criterion 6 (the blocked calls have no audit record).
// Measured with the current checker: 0/6, every criterion fails. Criteria 1, 2, 3, 4 and 6 are caused by mistake 3
// alone; criterion 5 is caused by mistake 2 (seq gap and forked link) and mistake 1 (record hash mismatch).
import { createHash } from "node:crypto";
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ZEROS = "0".repeat(64);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function localParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function hashOf(rec) {
  const body = { at: rec.at, seq: rec.seq, agentId: rec.agentId, userId: rec.userId, messageId: rec.messageId, decision: rec.decision, reason: rec.reason, prevHash: rec.prevHash };
  return createHash("sha256").update(rec.prevHash + JSON.stringify(body)).digest("hex");
}

const auditFile = () => {
  mkdirSync(process.env.STATE_DIR, { recursive: true });
  return join(process.env.STATE_DIR, "audit.jsonl");
};
function readRecords() {
  const file = auditFile();
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

export async function guardedSend({ agentId, user, message, now, send }) {
  const records = readRecords();
  const prevHash = records.length ? records[records.length - 1].hash : ZEROS;
  let reason = null;
  if (user.optedOut) reason = "The user has opted out of messages.";
  else {
    const { day, hour } = localParts(now, user.timezone);
    if (hour >= 21 || hour < 8) reason = "Blocked by quiet hours (21:00 to 08:00 local time).";
    else {
      const sent = records.filter((r) => r.decision === "allowed" && r.agentId === agentId && r.userId === user.id && localParts(new Date(r.at), user.timezone).day === day).length;
      if (sent >= 5) reason = "Blocked by the daily cap of 5 messages for this agent and user.";
    }
  }
  if (reason !== null) return { sent: false, reason }; // mistake 3: blocked calls are not recorded
  await sleep(1); // mistake 2: no lock between reading the last record and appending
  const rec = { seq: records.length + 1, at: now.toISOString(), agentId, userId: user.id, messageId: message.id, decision: "allowed", reason: null, prevHash };
  rec.hash = hashOf(rec);
  appendFileSync(auditFile(), JSON.stringify(rec) + "\n");
  await send();
  return { sent: true, reason: null };
}

export async function verifyAudit() {
  const file = auditFile();
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0) : [];
  let prevHash = ZEROS;
  for (let i = 0; i < lines.length; i++) {
    const rec = JSON.parse(lines[i]);
    if (rec.seq !== i + 1 || rec.prevHash !== prevHash || rec.hash !== hashOf(rec)) return { ok: false, brokenAt: i + 1 };
    prevHash = rec.hash;
  }
  return { ok: true, records: lines.length };
}
