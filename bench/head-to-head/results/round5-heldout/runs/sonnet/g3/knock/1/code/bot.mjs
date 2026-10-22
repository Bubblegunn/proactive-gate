import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Per-address append-only event log in STATE_DIR/optout/<sha256>.log.
// One JSON line per event, written with O_APPEND in a single write, so
// concurrent workers never lose or interleave events. The newest event by
// provider time wins; on an exact tie the unsubscribe wins.

function normalize(email) {
  let s = String(email ?? "").trim();
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, "").trim().replace(/^<|>$/g, "").trim();
  return s.toLowerCase();
}

function dir() {
  const base = process.env.STATE_DIR;
  if (!base) throw new Error("STATE_DIR is not set");
  const d = path.join(base, "optout");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function fileFor(email) {
  const h = crypto.createHash("sha256").update(normalize(email)).digest("hex");
  return path.join(dir(), h + ".log");
}

function toMs(at) {
  const ms = at instanceof Date ? at.getTime() : new Date(at).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

function append(email, type, ms) {
  if (!normalize(email)) throw new Error("empty email address");
  const line = JSON.stringify({ type, at: ms }) + "\n";
  const fd = fs.openSync(fileFor(email), "a");
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function recordUnsubscribe(email, at) {
  let ms = toMs(at);
  if (Number.isNaN(ms)) ms = Date.now(); // never lose an opt-out
  append(email, "unsub", ms);
}

export function recordResubscribe(email, at) {
  const ms = toMs(at);
  if (Number.isNaN(ms)) throw new TypeError("invalid resubscribe time");
  append(email, "resub", ms);
}

function isUnsubscribed(email) {
  let text;
  try {
    text = fs.readFileSync(fileFor(email), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
  let best = null;
  for (const l of text.split("\n")) {
    if (!l) continue;
    let ev;
    try { ev = JSON.parse(l); } catch { continue; }
    if (
      !best || ev.at > best.at ||
      (ev.at === best.at && ev.type === "unsub")
    ) best = ev;
  }
  return best?.type === "unsub";
}

export function mayEmail(message, now) {
  // Transactional mail (receipts, password resets) is exempt from opt-outs.
  // Anything that is not clearly transactional is treated as marketing.
  if (message?.kind === "transactional") return { allowed: true, reason: null };
  if (isUnsubscribed(message?.to)) return { allowed: false, reason: "unsubscribed" };
  return { allowed: true, reason: null };
}
