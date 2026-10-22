// Reference for X2 guardedSend and verifyAudit. Standalone: node builtins only.
// Decision order: opted out; then quiet hours (21:00 to 08:00 local, end exclusive); then the cap (5 allowed
// messages per agent and user per local calendar day). Blocked calls are recorded too.
// Each call takes an exclusive lock file (STATE_DIR/audit.lock, created with O_EXCL, spin with a 30 s timeout),
// reads the last record, decides, appends its record and releases the lock. send runs after the lock is released,
// and only for allowed calls.
// Record hash = sha256 hex of prevHash + JSON.stringify(record without hash), keys in the documented order.
import { createHash } from "node:crypto";
import { openSync, closeSync, readFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const ZEROS = "0".repeat(64);
const QUIET_FROM = 21;
const QUIET_TO = 8;
const CAP = 5;

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));

function withLock(stateDir, fn) {
  mkdirSync(stateDir, { recursive: true });
  const lock = join(stateDir, "audit.lock");
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (e) {
      if (e.code !== "EEXIST" || Date.now() > deadline) throw e;
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

// The hash covers every field except hash itself, in the documented key order, with prevHash as the prefix.
function hashOf(rec) {
  const body = {
    seq: rec.seq,
    at: rec.at,
    agentId: rec.agentId,
    userId: rec.userId,
    messageId: rec.messageId,
    decision: rec.decision,
    reason: rec.reason,
    prevHash: rec.prevHash,
  };
  return createHash("sha256").update(rec.prevHash + JSON.stringify(body)).digest("hex");
}

const auditFile = () => join(process.env.STATE_DIR, "audit.jsonl");

function readRecords() {
  const file = auditFile();
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

export async function guardedSend({ agentId, user, message, now, send }) {
  const decision = withLock(process.env.STATE_DIR, () => {
    const records = readRecords();
    const prevHash = records.length ? records[records.length - 1].hash : ZEROS;
    let reason = null;
    if (user.optedOut) {
      reason = "The user has opted out of messages.";
    } else {
      const { day, hour } = localParts(now, user.timezone);
      if (hour >= QUIET_FROM || hour < QUIET_TO) {
        reason = "Blocked by quiet hours (21:00 to 08:00 local time).";
      } else {
        const sent = records.filter(
          (r) =>
            r.decision === "allowed" &&
            r.agentId === agentId &&
            r.userId === user.id &&
            localParts(new Date(r.at), user.timezone).day === day,
        ).length;
        if (sent >= CAP) reason = `Blocked by the daily cap of ${CAP} messages for this agent and user.`;
      }
    }
    const rec = {
      seq: records.length + 1,
      at: now.toISOString(),
      agentId,
      userId: user.id,
      messageId: message.id,
      decision: reason === null ? "allowed" : "blocked",
      reason,
      prevHash,
    };
    rec.hash = hashOf(rec);
    appendFileSync(auditFile(), JSON.stringify(rec) + "\n");
    return { allowed: reason === null, reason };
  });
  if (!decision.allowed) return { sent: false, reason: decision.reason };
  await send();
  return { sent: true, reason: null };
}

export async function verifyAudit() {
  const file = auditFile();
  const lines = existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
    : [];
  let prevHash = ZEROS;
  for (let i = 0; i < lines.length; i++) {
    const want = i + 1;
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      return { ok: false, brokenAt: want };
    }
    if (rec.seq !== want || rec.prevHash !== prevHash || rec.hash !== hashOf(rec)) return { ok: false, brokenAt: want };
    prevHash = rec.hash;
  }
  return { ok: true, records: lines.length };
}
