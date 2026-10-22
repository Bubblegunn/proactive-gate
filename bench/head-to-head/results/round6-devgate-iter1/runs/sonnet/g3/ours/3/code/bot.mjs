import { mkdirSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

// Normalize "Name <User@Example.COM>", "mailto:...", padded input to "user@example.com".
function normalize(email) {
  if (typeof email !== "string") return null;
  let s = email.trim();
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, "").trim().replace(/^"|"$/g, "");
  s = s.toLowerCase();
  if (!/^[^\s@<>,;]+@[^\s@<>,;]+$/.test(s)) return null;
  return s;
}

function dirFor(addr) {
  const base = process.env.STATE_DIR;
  if (!base) throw new Error("STATE_DIR is not set");
  const d = join(base, "email-events", createHash("sha256").update(addr).digest("hex"));
  mkdirSync(d, { recursive: true });
  return d;
}

// One immutable file per event, written by temp file + rename: no read-modify-write,
// so concurrent workers never lose an update and replays are harmless.
function record(type, email, at) {
  const addr = normalize(email);
  if (!addr) throw new Error("invalid email address");
  const t = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (!Number.isFinite(t)) throw new Error("invalid event time");
  const d = dirFor(addr);
  const name = `${String(t).padStart(16, "0")}-${type}-${randomBytes(6).toString("hex")}.json`;
  const tmp = join(d, `.tmp-${randomBytes(6).toString("hex")}`);
  writeFileSync(tmp, JSON.stringify({ type, at: t }));
  renameSync(tmp, join(d, name));
}

export function recordUnsubscribe(email, at) {
  record("unsub", email, at);
}

export function recordResubscribe(email, at) {
  record("resub", email, at);
}

export function mayEmail(message, now) {
  // Receipts, password resets and other transactional mail are exempt from opt-outs.
  if (message?.kind === "transactional") return { allowed: true, reason: null };
  const addr = normalize(message?.to);
  if (!addr) return { allowed: false, reason: "invalid_address" };
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const d = dirFor(addr);
  let latest = null; // latest by provider time; a tie goes to the unsubscribe
  for (const f of readdirSync(d)) {
    const m = f.match(/^(\d+)-(unsub|resub)-[0-9a-f]+\.json$/);
    if (!m) continue;
    const at = Number(m[1]);
    const type = m[2];
    // An unsubscribe always counts. A resubscribe dated after now is not yet in effect.
    if (type === "resub" && Number.isFinite(nowMs) && at > nowMs) continue;
    if (!latest || at > latest.at || (at === latest.at && type === "unsub")) latest = { at, type };
  }
  if (latest && latest.type === "unsub") return { allowed: false, reason: "unsubscribed" };
  return { allowed: true, reason: null };
}
