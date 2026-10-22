import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, readdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

// State layout: $STATE_DIR/events/<sha256(address)>/<type>.<atMs>.<random>
// One empty file per event, created exclusively, so workers never do
// read-modify-write and cannot lose each other's events. The filename holds the data.

function normalize(email) {
  if (typeof email !== "string") return null;
  let s = email.trim();
  const angle = s.match(/<([^<>]*)>\s*$/); // "Name <<EMAIL>>" header form
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, "").trim().replace(/^["']+|["']+$/g, "");
  s = s.toLowerCase();
  if (!/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(s)) return null;
  return s;
}

function addrDir(addr) {
  const base = process.env.STATE_DIR;
  if (!base) throw new Error("STATE_DIR is not set");
  return join(base, "events", createHash("sha256").update(addr).digest("hex"));
}

function record(type, email, at, fallbackToNow) {
  const addr = normalize(email);
  if (!addr) throw new TypeError(`invalid email address: ${email}`);
  let ms = new Date(at).getTime();
  if (!Number.isFinite(ms)) {
    if (!fallbackToNow) throw new TypeError("invalid date");
    ms = Date.now(); // unsubscribe with unusable time: suppress from now on
  }
  const dir = addrDir(addr);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${type}.${ms}.${randomBytes(8).toString("hex")}`);
  const fd = openSync(file, "wx");
  fsyncSync(fd);
  closeSync(fd);
  const dfd = openSync(dir, "r");
  try { fsyncSync(dfd); } finally { closeSync(dfd); }
}

export function recordUnsubscribe(email, at) {
  record("u", email, at, true);
}

export function recordResubscribe(email, at) {
  record("r", email, at, false);
}

export function mayEmail(message, now) {
  // Transactional (receipts, password resets) is exempt from opt-outs.
  if (message && message.kind === "transactional") return { allowed: true, reason: null };
  // Anything else is treated as marketing (fail closed).
  const addr = normalize(message && message.to);
  if (!addr) return { allowed: false, reason: "invalid_address" };
  let names = [];
  try {
    names = readdirSync(addrDir(addr));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  let lastU = -Infinity, lastR = -Infinity;
  for (const n of names) {
    const [t, ms] = n.split(".");
    const v = Number(ms);
    if (!Number.isFinite(v)) continue;
    if (t === "u" && v > lastU) lastU = v;
    else if (t === "r" && v > lastR) lastR = v;
  }
  // Latest event by provider time wins; a tie goes to the unsubscribe.
  if (lastU === -Infinity || lastR > lastU) return { allowed: true, reason: null };
  return { allowed: false, reason: "unsubscribed" };
}
