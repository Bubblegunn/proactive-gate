import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Normalise an address typed by a person or taken from a header:
// "Name <<EMAIL>>", "mailto:<EMAIL>", surrounding spaces/quotes, any case.
function normalize(email) {
  if (typeof email !== "string") return null;
  let s = email.trim();
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1];
  s = s.trim().replace(/^mailto:/i, "").replace(/^["'<\s]+|["'>\s]+$/g, "").toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(s) ? s : null;
}

function dirFor(addr) {
  const base = process.env.STATE_DIR; // read on every call
  if (!base) throw new Error("STATE_DIR is not set");
  const d = join(base, "subs", createHash("sha256").update(addr).digest("hex"));
  mkdirSync(d, { recursive: true });
  return d;
}

// Append-only: one file per event, written to a temp name then renamed, so
// concurrent workers never overwrite each other and no lock is needed.
function record(type, email, at) {
  const addr = normalize(email);
  if (!addr) throw new TypeError("invalid email address");
  const ms = at instanceof Date ? at.getTime() : NaN;
  if (!Number.isFinite(ms)) throw new TypeError("invalid event time");
  const d = dirFor(addr);
  const name = `${type}-${ms}-${randomBytes(6).toString("hex")}`;
  const tmp = join(d, `.tmp-${name}`);
  writeFileSync(tmp, "");
  renameSync(tmp, join(d, name));
}

export function recordUnsubscribe(email, at) {
  record("u", email, at);
}

export function recordResubscribe(email, at) {
  record("r", email, at);
}

function latest(d) {
  let u = -Infinity, r = -Infinity;
  for (const f of readdirSync(d)) {
    const m = f.match(/^([ur])-(-?\d+)-/);
    if (!m) continue;
    const t = Number(m[2]);
    if (m[1] === "u") u = Math.max(u, t); else r = Math.max(r, t);
  }
  return { u, r };
}

export function mayEmail(message, now) {
  // Transactional (receipts, password resets) are exempt from opt-outs.
  if (message?.kind === "transactional") return { allowed: true, reason: null };
  if (message?.kind !== "marketing") return { allowed: false, reason: "unknown_kind" };
  const addr = normalize(message.to);
  if (!addr) return { allowed: false, reason: "invalid_address" };
  const { u, r } = latest(dirFor(addr));
  // The event with the later provider time wins; a tie favours the opt-out.
  if (u > -Infinity && u >= r) return { allowed: false, reason: "unsubscribed" };
  return { allowed: true, reason: null };
}
