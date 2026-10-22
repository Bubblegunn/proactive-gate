import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Opt-out state: one append-only log file per mailbox in STATE_DIR/optouts.
// Appends of one short line with O_APPEND are atomic across processes, so
// workers need no locks. The state is derived from the log on every check.

function dir() {
  const base = process.env.STATE_DIR;
  if (!base) throw new Error("STATE_DIR is not set");
  const d = path.join(base, "optouts");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Reduce an address as typed or as found in a header to one mailbox key.
// Returns null when no address can be found.
export function normalize(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, "").trim();
  const q = s.indexOf("?");
  if (q > 0) s = s.slice(0, q);
  s = s.replace(/^["']+|["']+$/g, "").normalize("NFKC").toLowerCase();
  const at = s.lastIndexOf("@");
  if (at < 1 || at === s.length - 1 || /\s/.test(s)) return null;
  let local = s.slice(0, at);
  let domain = s.slice(at + 1).replace(/\.+$/, "");
  if (!domain) return null;
  if (domain === "googlemail.com") domain = "gmail.com";
  // "+tag" addresses deliver to the same mailbox; the person is the same.
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

function fileFor(key) {
  return path.join(dir(), crypto.createHash("sha256").update(key).digest("hex") + ".log");
}

function append(key, type, ms) {
  const line = JSON.stringify({ type, ms }) + "\n";
  const fd = fs.openSync(fileFor(key), "a");
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function toMs(at) {
  const ms = at instanceof Date ? at.getTime() : new Date(at).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function recordUnsubscribe(email, at) {
  const key = normalize(email);
  if (!key) throw new Error("invalid email address");
  // Never lose an opt-out because of a bad timestamp.
  append(key, "unsub", toMs(at) ?? Date.now());
}

export function recordResubscribe(email, at) {
  const key = normalize(email);
  if (!key) throw new Error("invalid email address");
  const ms = toMs(at);
  if (ms === null) throw new Error("invalid timestamp");
  append(key, "resub", ms);
}

function isOptedOut(key) {
  let text;
  try {
    text = fs.readFileSync(fileFor(key), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
  // Latest event by provider time wins; on a tie the unsubscribe wins.
  let best = null;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!best || ev.ms > best.ms || (ev.ms === best.ms && ev.type === "unsub")) best = ev;
  }
  return best !== null && best.type === "unsub";
}

export function mayEmail(message, now) {
  // Transactional mail (receipts, password resets) is exempt from opt-outs.
  if (message && message.kind === "transactional") return { allowed: true, reason: null };
  const key = normalize(message && message.to);
  if (!key) return { allowed: false, reason: "invalid_recipient" };
  if (isOptedOut(key)) return { allowed: false, reason: "unsubscribed" };
  return { allowed: true, reason: null };
}
