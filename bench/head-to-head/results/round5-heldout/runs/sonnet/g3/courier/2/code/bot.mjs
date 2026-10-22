import { createHash } from "node:crypto";
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Per-address append-only log in STATE_DIR. A single O_APPEND write of one short
// line is atomic across processes, so no locks are needed. Events are compared by
// the provider timestamp, not by arrival order, so late/out-of-order events work.

function dir() {
  const d = process.env.STATE_DIR;
  if (!d) throw new Error("STATE_DIR is not set");
  mkdirSync(d, { recursive: true });
  return d;
}

// Accepts "<EMAIL>", " <EMAIL> ", "Name <<EMAIL>>", "mailto:<EMAIL>".
export function normalize(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, "").trim().replace(/^<|>$/g, "").trim();
  s = s.normalize("NFC").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(s)) return null;
  return s;
}

function fileFor(norm) {
  return join(dir(), "addr-" + createHash("sha256").update(norm).digest("hex") + ".log");
}

function toMs(at) {
  const t = at instanceof Date ? at.getTime() : new Date(at).getTime();
  return Number.isFinite(t) ? t : Date.now();
}

function append(type, email, at) {
  const norm = normalize(email);
  if (!norm) throw new Error("invalid email address");
  const line = JSON.stringify({ type, at: toMs(at), email: norm }) + "\n";
  const fd = openSync(fileFor(norm), "a");
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function recordUnsubscribe(email, at) {
  append("unsub", email, at);
}

export function recordResubscribe(email, at) {
  append("resub", email, at);
}

function isUnsubscribed(norm) {
  let text;
  try {
    text = readFileSync(fileFor(norm), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
  let latest = null; // { type, at }
  for (const l of text.split("\n")) {
    if (!l) continue;
    let ev;
    try { ev = JSON.parse(l); } catch { continue; }
    if (ev.type !== "unsub" && ev.type !== "resub") continue;
    // Latest provider time wins; on a tie the opt-out wins.
    if (!latest || ev.at > latest.at || (ev.at === latest.at && ev.type === "unsub")) latest = ev;
  }
  return latest !== null && latest.type === "unsub";
}

export function mayEmail(message, now) {
  // Transactional (receipts, password resets) is exempt from opt-outs under CAN-SPAM.
  if (message && message.kind === "transactional") return { allowed: true, reason: null };
  // Anything else (including unknown kinds) is treated as marketing.
  const norm = normalize(message && message.to);
  if (!norm) return { allowed: false, reason: "invalid_address" };
  try {
    if (isUnsubscribed(norm)) return { allowed: false, reason: "unsubscribed" };
  } catch {
    return { allowed: false, reason: "state_unreadable" };
  }
  return { allowed: true, reason: null };
}
