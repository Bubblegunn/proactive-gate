import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Normalize an address typed by a person or taken from a header
// ("Name <<EMAIL>>", "mailto:<EMAIL>", surrounding quotes/spaces).
function normalize(email) {
  if (typeof email !== "string") return null;
  let s = email.trim();
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, "").replace(/^["'<]+|["'>]+$/g, "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(s) ? s : null;
}

// STATE_DIR is read on every call. One event per file, written to a temp name
// and renamed, so concurrent workers never overwrite each other.
function userDir(addr) {
  const base = process.env.STATE_DIR;
  if (!base) throw new Error("STATE_DIR is not set");
  const dir = join(base, "optout", createHash("sha256").update(addr).digest("hex"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function record(email, at, type) {
  const addr = normalize(email);
  if (!addr) return;
  let t = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (!Number.isFinite(t)) t = Date.now();
  const dir = userDir(addr);
  const name = `${String(t).padStart(16, "0")}-${type}-${randomBytes(6).toString("hex")}`;
  const tmp = join(dir, `.tmp-${name}`);
  writeFileSync(tmp, JSON.stringify({ type, t, addr }));
  renameSync(tmp, join(dir, `${name}.json`));
}

export function recordUnsubscribe(email, at) {
  record(email, at, "unsub");
}

export function recordResubscribe(email, at) {
  record(email, at, "resub");
}

// Latest event by provider time wins; on a tie the unsubscribe wins.
function unsubscribed(addr) {
  const dir = userDir(addr);
  let best = null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    let e;
    try { e = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
    if (!best || e.t > best.t || (e.t === best.t && e.type === "unsub")) best = e;
  }
  return best?.type === "unsub";
}

export function mayEmail(message, now) {
  // Transactional mail (receipts, password resets) is exempt from opt-outs.
  if (message?.kind === "transactional") return { allowed: true, reason: null };
  const addr = normalize(message?.to);
  // Unknown kinds are treated as marketing.
  if (!addr) return { allowed: false, reason: "invalid_address" };
  if (unsubscribed(addr)) return { allowed: false, reason: "unsubscribed" };
  return { allowed: true, reason: null };
}
