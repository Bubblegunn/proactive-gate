import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Opt-out state: one directory per normalized address, one immutable file per event.
// Files are written to a temp name and renamed, so concurrent workers never need a lock
// and a crash never leaves a partial event. Current state = latest event by provider time;
// on equal time, unsubscribe wins.

function stateRoot() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR is not set");
  return join(dir, "optouts");
}

// Accepts "<EMAIL>", " <EMAIL> ", "Name <<EMAIL>>", "<<EMAIL>>", "mailto:<EMAIL>".
export function normalizeEmail(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.normalize("NFKC").trim();
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, "").trim().replace(/^"+|"+$/g, "");
  s = s.toLowerCase();
  const at = s.lastIndexOf("@");
  if (at < 1 || at === s.length - 1 || /\s/.test(s)) return null;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1).replace(/\.+$/, "");
  if (!domain) return null;
  return `${local}@${domain}`;
}

function addrDir(email) {
  return join(stateRoot(), createHash("sha256").update(email).digest("hex"));
}

function writeEvent(email, type, ms) {
  const dir = addrDir(email);
  mkdirSync(dir, { recursive: true });
  const id = `${String(ms).padStart(16, "0")}.${type}.${randomBytes(6).toString("hex")}`;
  const tmp = join(dir, `.tmp-${id}`);
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, JSON.stringify({ email, type, at: ms }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, join(dir, id));
}

function toMs(at) {
  const ms = at instanceof Date ? at.getTime() : new Date(at).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function recordUnsubscribe(email, at) {
  const e = normalizeEmail(email);
  if (!e) throw new TypeError("recordUnsubscribe: invalid email address");
  // Unknown time: fail safe by treating it as happening now.
  writeEvent(e, "unsub", toMs(at) ?? Date.now());
}

export function recordResubscribe(email, at) {
  const e = normalizeEmail(email);
  if (!e) throw new TypeError("recordResubscribe: invalid email address");
  const ms = toMs(at);
  if (ms === null) throw new TypeError("recordResubscribe: invalid date");
  writeEvent(e, "resub", ms);
}

function isUnsubscribed(email) {
  let names;
  try {
    names = readdirSync(addrDir(email));
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
  let bestMs = -Infinity;
  let unsub = false;
  for (const n of names) {
    if (n.startsWith(".tmp-")) continue;
    const [msStr, type] = n.split(".");
    const ms = Number(msStr);
    if (ms > bestMs) {
      bestMs = ms;
      unsub = type === "unsub";
    } else if (ms === bestMs && type === "unsub") {
      unsub = true;
    }
  }
  return unsub;
}

export function mayEmail(message, now) {
  const kind = message && message.kind;
  if (kind !== "marketing" && kind !== "transactional") {
    return { allowed: false, reason: "unknown_kind" };
  }
  // Receipts, password resets and other transactional mail stay allowed (CAN-SPAM 7702(2)(B)).
  if (kind === "transactional") return { allowed: true, reason: null };
  const e = normalizeEmail(message.to);
  if (!e) return { allowed: false, reason: "invalid_recipient" };
  if (isUnsubscribed(e)) return { allowed: false, reason: "unsubscribed" };
  return { allowed: true, reason: null };
}
