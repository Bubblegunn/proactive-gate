import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Opt-out state: one small immutable file per event, in STATE_DIR/optouts/<sha256(address)>/.
// Files are written to a temp name, fsynced, then renamed, so concurrent workers never
// need locks and a crash never leaves a half-written event. The current state of an
// address is derived from all its events: the event with the latest provider time wins,
// and on an exact tie the unsubscribe wins. So late or out-of-order delivery is harmless.

function normalize(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  const angle = s.match(/<([^<>]*)>\s*[^<>]*$/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, "").replace(/^["'\s]+|["'\s]+$/g, "");
  const at = s.lastIndexOf("@");
  if (at < 1 || at === s.length - 1 || /\s/.test(s)) return null;
  return (s.slice(0, at) + "@" + s.slice(at + 1).replace(/\.$/, "")).toLowerCase();
}

function dirFor(email, create) {
  const base = process.env.STATE_DIR;
  if (!base) throw new Error("STATE_DIR is not set");
  const d = join(base, "optouts", createHash("sha256").update(email).digest("hex"));
  if (create) mkdirSync(d, { recursive: true });
  return d;
}

function toTime(at) {
  const t = at instanceof Date ? at.getTime() : new Date(at).getTime();
  return Number.isFinite(t) ? t : Date.now();
}

function record(type, email, at) {
  const addr = normalize(email);
  if (!addr) return;
  const dir = dirFor(addr, true);
  const name = `${String(toTime(at)).padStart(16, "0")}-${type}-${process.pid}-${randomBytes(6).toString("hex")}`;
  const tmp = join(dir, `.tmp-${name}`);
  const fd = openSync(tmp, "wx");
  try {
    writeSync(fd, JSON.stringify({ type, email: addr, at: toTime(at) }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, join(dir, `${name}.json`));
  try {
    const dfd = openSync(dir, "r");
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
  } catch {}
}

function isUnsubscribed(addr) {
  let files;
  try {
    files = readdirSync(dirFor(addr, false));
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
  let latest = -1;
  let unsub = false;
  for (const f of files) {
    if (!f.endsWith(".json") || f.startsWith(".")) continue;
    const m = f.match(/^(\d+)-(unsub|resub)-/);
    if (!m) continue;
    const t = Number(m[1]);
    const isUnsub = m[2] === "unsub";
    if (t > latest || (t === latest && isUnsub)) {
      latest = t;
      unsub = isUnsub;
    }
  }
  return unsub;
}

export function recordUnsubscribe(email, at) {
  record("unsub", email, at);
}

export function recordResubscribe(email, at) {
  record("resub", email, at);
}

export function mayEmail(message, now) {
  const kind = message && message.kind;
  // Receipts and password resets are transactional: CAN-SPAM exempts them and
  // people expect them even after opting out of marketing.
  if (kind === "transactional") return { allowed: true, reason: null };
  // Anything else (including unknown kinds) is treated as marketing.
  const addr = normalize(message && message.to);
  if (!addr) return { allowed: false, reason: "invalid_address" };
  if (isUnsubscribed(addr)) return { allowed: false, reason: "unsubscribed" };
  return { allowed: true, reason: null };
}
