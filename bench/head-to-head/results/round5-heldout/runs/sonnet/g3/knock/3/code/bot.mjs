import { mkdirSync, writeFileSync, renameSync, readdirSync, openSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

// Opt-out state: one small immutable file per event, in STATE_DIR/events/<hash of address>/.
// Files are written to a temp name and renamed, so no worker sees a partial file and no
// lock is needed. The state of an address is its event with the latest provider time.

function normalize(email) {
  let s = String(email ?? "").trim();
  const angle = s.match(/<([^<>]*)>/);
  if (angle) s = angle[1];
  s = s.trim().replace(/^mailto:/i, "").replace(/^["']+|["']+$/g, "").trim();
  s = s.toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(s) ? s : null;
}

function dirFor(addr) {
  const base = process.env.STATE_DIR;
  if (!base) throw new Error("STATE_DIR is not set");
  const h = createHash("sha256").update(addr).digest("hex");
  return join(base, "events", h);
}

function record(email, at, type) {
  const addr = normalize(email);
  if (!addr) return;
  let t = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (!Number.isFinite(t)) t = Date.now();
  const dir = dirFor(addr);
  mkdirSync(dir, { recursive: true });
  const name = `${String(t).padStart(16, "0")}-${type}-${randomBytes(6).toString("hex")}.json`;
  const tmp = join(dir, `.tmp-${name}`);
  writeFileSync(tmp, JSON.stringify({ addr, type, t }));
  const fd = openSync(tmp, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, join(dir, name));
}

function isUnsubscribed(addr) {
  let names;
  try { names = readdirSync(dirFor(addr)); } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
  let bestT = -Infinity;
  let unsub = false;
  for (const n of names) {
    const m = n.match(/^(\d{16})-(unsub|resub)-[0-9a-f]+\.json$/);
    if (!m) continue;
    const t = Number(m[1]);
    const u = m[2] === "unsub";
    // later event wins; on an exact tie the opt-out wins
    if (t > bestT || (t === bestT && u)) { bestT = t; unsub = u; }
  }
  return unsub;
}

export function recordUnsubscribe(email, at) {
  record(email, at, "unsub");
}

export function recordResubscribe(email, at) {
  record(email, at, "resub");
}

export function mayEmail(message, now) {
  // Receipts, password resets and other transactional mail are exempt from opt-outs.
  if (message && message.kind === "transactional") return { allowed: true, reason: null };
  // Anything else is treated as marketing.
  const addr = normalize(message && message.to);
  if (!addr) return { allowed: false, reason: "invalid_address" };
  if (isUnsubscribed(addr)) return { allowed: false, reason: "unsubscribed" };
  return { allowed: true, reason: null };
}
