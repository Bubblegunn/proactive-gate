import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// One immutable event file per unsubscribe/resubscribe, under
// $STATE_DIR/optout/<sha256(address)>/<ms>.<u|r>.<random>. Writes are temp file + rename,
// so no two workers overwrite each other and a restart loses nothing. The state of an
// address is derived from the newest event time, so late or out-of-order delivery gives
// the same result in every worker.

function stateDir() {
  const d = process.env.STATE_DIR;
  if (!d) throw new Error("STATE_DIR is not set");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Accepts "<EMAIL>", " <EMAIL> ", "Name <<EMAIL>>", "<<EMAIL>>", "mailto:<EMAIL>".
export function normalizeEmail(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, "").trim().replace(/^"+|"+$/g, "");
  s = s.toLowerCase();
  if (!/^[^\s@<>,;:"]+@[^\s@<>,;:"]+\.[^\s@<>,;:"]+$/.test(s)) return null;
  return s;
}

function dirFor(base, email) {
  const h = crypto.createHash("sha256").update(email).digest("hex");
  return path.join(base, "optout", h);
}

function writeEvent(email, type, ms) {
  const base = stateDir();
  const dir = dirFor(base, email);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(base, "tmp"), { recursive: true });
  const rand = crypto.randomBytes(8).toString("hex");
  const tmp = path.join(base, "tmp", `${process.pid}.${rand}`);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, JSON.stringify({ email, type, at: ms }));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, path.join(dir, `${String(ms).padStart(16, "0")}.${type}.${rand}`));
}

function toMs(at, fallbackNow) {
  const ms = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (Number.isFinite(ms)) return Math.max(ms, 0);
  return fallbackNow ? Date.now() : null;
}

export function recordUnsubscribe(email, at) {
  const e = normalizeEmail(email);
  if (!e) throw new TypeError("recordUnsubscribe: invalid email address");
  // An unusable timestamp must never leave the person subscribed: use receipt time.
  writeEvent(e, "u", toMs(at, true));
}

export function recordResubscribe(email, at) {
  const e = normalizeEmail(email);
  if (!e) throw new TypeError("recordResubscribe: invalid email address");
  const ms = toMs(at, false);
  if (ms === null) throw new TypeError("recordResubscribe: invalid date");
  writeEvent(e, "r", ms);
}

function isUnsubscribed(email) {
  const dir = dirFor(stateDir(), email);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  let u = -1;
  let r = -1;
  for (const n of names) {
    const m = n.match(/^(\d+)\.(u|r)\./);
    if (!m) continue;
    const ms = Number(m[1]);
    if (m[2] === "u") u = Math.max(u, ms);
    else r = Math.max(r, ms);
  }
  // Newest event wins; on an exact tie the unsubscribe wins.
  return u >= 0 && u >= r;
}

export function mayEmail(message, now) {
  const kind = message && message.kind;
  if (kind === "transactional") {
    // Receipts and password resets are not promotional; an opt-out from marketing does not stop them.
    return { allowed: true, reason: null };
  }
  if (kind !== "marketing") return { allowed: false, reason: "unknown_kind" };
  const e = normalizeEmail(message.to);
  if (!e) return { allowed: false, reason: "invalid_address" };
  if (isUnsubscribed(e)) return { allowed: false, reason: "unsubscribed" };
  return { allowed: true, reason: null };
}
