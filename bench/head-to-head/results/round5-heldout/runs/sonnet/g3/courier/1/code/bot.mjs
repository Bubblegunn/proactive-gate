import { appendFileSync, mkdirSync, readFileSync, openSync, fsyncSync, closeSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

// Events live in STATE_DIR/events/<sha256(normalized address)>.log, one JSON
// line per event, written with a single O_APPEND write. Appends are atomic
// across processes on one machine, need no lock, and survive restarts.
// State is derived on read: the event with the latest provider time wins;
// on a tie, the unsubscribe wins.

function dir() {
  const base = process.env.STATE_DIR;
  if (!base) throw new Error("STATE_DIR is not set");
  const d = join(base, "events");
  mkdirSync(d, { recursive: true });
  return d;
}

// Accepts "<EMAIL>", " <EMAIL> ", "Name <<EMAIL>>", "<<EMAIL>>", "mailto:<EMAIL>".
export function normalizeEmail(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1];
  s = s.trim().replace(/^mailto:/i, "").trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at < 1 || at === s.length - 1) return null;
  let local = s.slice(0, at);
  let domain = s.slice(at + 1).replace(/\.+$/, "");
  if (!domain) return null;
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  if (!local) return null;
  return `${local}@${domain}`;
}

function fileFor(norm) {
  return join(dir(), createHash("sha256").update(norm).digest("hex") + ".log");
}

function toMs(at, fallbackNow) {
  const t = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (Number.isFinite(t)) return t;
  if (fallbackNow) return Date.now();
  throw new Error("invalid event time");
}

function append(email, type, at, fallbackNow) {
  const norm = normalizeEmail(email);
  if (!norm) throw new Error("invalid email address");
  const line = JSON.stringify({ type, at: toMs(at, fallbackNow) }) + "\n";
  const fd = openSync(fileFor(norm), "a");
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function recordUnsubscribe(email, at) {
  // A missing/invalid time must never lose an opt-out: use the local clock.
  append(email, "unsub", at, true);
}

export function recordResubscribe(email, at) {
  append(email, "resub", at, false);
}

function isUnsubscribed(norm) {
  let text;
  try {
    text = readFileSync(fileFor(norm), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
  let lastUnsub = -Infinity;
  let lastResub = -Infinity;
  for (const l of text.split("\n")) {
    if (!l) continue;
    let ev;
    try { ev = JSON.parse(l); } catch { continue; }
    if (ev.type === "unsub") lastUnsub = Math.max(lastUnsub, ev.at);
    else if (ev.type === "resub") lastResub = Math.max(lastResub, ev.at);
  }
  if (lastUnsub === -Infinity) return false;
  return !(lastResub > lastUnsub);
}

export function mayEmail(message, now) {
  // Transactional messages (receipts, password resets) are exempt from
  // opt-outs under CAN-SPAM; anything not clearly transactional is marketing.
  if (message && message.kind === "transactional") return { allowed: true, reason: null };
  const norm = normalizeEmail(message && message.to);
  if (norm && isUnsubscribed(norm)) return { allowed: false, reason: "unsubscribed" };
  return { allowed: true, reason: null };
}
