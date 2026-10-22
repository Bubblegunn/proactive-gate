import { mkdir, readdir, open, rename } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

// Opt-out state lives in STATE_DIR/optouts/<sha256(address)>/<ms>-<u|r>-<hash>.
// One immutable file per event, written to a temp name and renamed into place,
// so concurrent workers never overwrite each other and a restart loses nothing.
// The verdict for an address is the event with the latest provider time;
// on an exact tie the unsubscribe wins.

function stateRoot() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR is not set");
  return path.join(dir, "optouts");
}

// Accepts "<EMAIL>", " <EMAIL> ", "Name <<EMAIL>>", "<<EMAIL>>", "mailto:<EMAIL>".
function normalizeEmail(raw) {
  let s = String(raw ?? "").trim();
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1];
  s = s.trim().replace(/^mailto:/i, "").trim();
  return s.toLowerCase();
}

function addressDir(email) {
  return path.join(stateRoot(), createHash("sha256").update(email).digest("hex"));
}

function toMillis(at) {
  const ms = at instanceof Date ? at.getTime() : new Date(at).getTime();
  // An unreadable timestamp must not lose an opt-out; treat it as happening now.
  return Number.isFinite(ms) ? ms : Date.now();
}

async function record(type, email, at) {
  const addr = normalizeEmail(email);
  if (!addr) throw new TypeError("email is required");
  const ms = toMillis(at);
  const dir = addressDir(addr);
  await mkdir(dir, { recursive: true });
  // Same event delivered twice gets the same name, so retries are harmless.
  const name = `${String(ms).padStart(16, "0")}-${type}`;
  const tmp = path.join(dir, `.tmp-${randomUUID()}`);
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(JSON.stringify({ email: addr, type, at: ms }));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path.join(dir, name));
}

export function recordUnsubscribe(email, at) {
  return record("u", email, at);
}

export function recordResubscribe(email, at) {
  return record("r", email, at);
}

async function isUnsubscribed(addr) {
  let names;
  try {
    names = await readdir(addressDir(addr));
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
  let bestMs = -1;
  let bestType = null;
  for (const n of names) {
    const m = /^(\d{16})-([ur])$/.exec(n);
    if (!m) continue;
    const ms = Number(m[1]);
    if (ms > bestMs || (ms === bestMs && m[2] === "u")) {
      bestMs = ms;
      bestType = m[2];
    }
  }
  return bestType === "u";
}

export async function mayEmail(message, now) {
  // Receipts and password resets are transactional or relationship messages;
  // CAN-SPAM lets them go out after an opt-out from marketing.
  if (message?.kind === "transactional") return { allowed: true, reason: null };
  // Anything else is treated as marketing, the safe side.
  const addr = normalizeEmail(message?.to);
  if (addr && (await isUnsubscribed(addr))) {
    return { allowed: false, reason: "unsubscribed" };
  }
  return { allowed: true, reason: null };
}
