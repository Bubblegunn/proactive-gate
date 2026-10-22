// Email consent and suppression for newsletters and receipts.
//
// Storage: one append-only log per address under $STATE_DIR/consent/.
// Each line is one JSON event: {"type":"subscribe"|"unsubscribe","at":ISO}.
// The last valid line of a log is the current state. Workers share nothing
// but STATE_DIR, so every read and write goes through the files.
//
// Writes use O_APPEND with one write call per event and fsync before return.
// Concurrent appends from several processes land as whole lines in one order,
// and an unsubscribe is durable before unsubscribe() resolves.
//
// Rules applied by mayEmail():
// - "receipt" (order confirmation, shipping, password reset) is transactional.
//   It is allowed regardless of marketing opt-out.
// - "marketing" needs an explicit opt-in on record (resubscribe() writes one).
//   Without one, marketing is blocked, because EU rules (GDPR, ePrivacy) need
//   prior consent and this module cannot tell an EU address from a US one.
//   Any later unsubscribe blocks marketing until the person signs up again.
// - Unsubscribes never expire. They are honoured at once, which is inside the
//   US CAN-SPAM 10-business-day window and the EU "without undue delay" rule.
// - If a log cannot be parsed, marketing is blocked. A lost unsubscribe must
//   not turn into a sent email. Receipts are still allowed.
// - Invalid addresses are refused for every kind.

import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

const KINDS = new Set(["marketing", "receipt"]);

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) {
    throw new Error("STATE_DIR environment variable is not set");
  }
  return dir;
}

// Lower-case, trimmed, NFKC-normalised address. Returns null if the value
// does not look like an address.
function normalizeEmail(email) {
  if (typeof email !== "string") return null;
  const s = email.normalize("NFKC").trim().toLowerCase();
  if (s.length === 0 || s.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s;
}

function logPath(dir, normalized) {
  // Hash the address so file names do not carry the address itself.
  const digest = createHash("sha256").update(normalized).digest("hex");
  return join(dir, "consent", `${digest}.jsonl`);
}

async function appendEvent(email, type) {
  const normalized = normalizeEmail(email);
  if (normalized === null) {
    throw new TypeError("invalid email address");
  }
  const dir = stateDir();
  await mkdir(join(dir, "consent"), { recursive: true });
  const line = JSON.stringify({ type, at: new Date().toISOString() }) + "\n";
  const handle = await open(logPath(dir, normalized), "a");
  try {
    await handle.appendFile(line, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Returns { events, corrupt }. A missing log is an empty history.
async function readEvents(normalized) {
  let text;
  try {
    text = await readFile(logPath(stateDir(), normalized), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { events: [], corrupt: false };
    throw err;
  }
  const events = [];
  let corrupt = false;
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    try {
      const ev = JSON.parse(raw);
      if (ev.type !== "subscribe" && ev.type !== "unsubscribe") {
        corrupt = true;
      } else {
        events.push(ev);
      }
    } catch {
      corrupt = true;
    }
  }
  return { events, corrupt };
}

function dayOf(iso) {
  return iso.slice(0, 10);
}

export async function unsubscribe(email) {
  await appendEvent(email, "unsubscribe");
}

export async function resubscribe(email) {
  await appendEvent(email, "subscribe");
}

export async function mayEmail(email, kind, now) {
  if (!KINDS.has(kind)) {
    throw new TypeError(`unknown kind: ${String(kind)}`);
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }

  const normalized = normalizeEmail(email);
  if (normalized === null) {
    return { allowed: false, reason: "The address is not a valid email address, so nothing was sent." };
  }

  if (kind === "receipt") {
    return { allowed: true, reason: "Transactional receipt; marketing opt-out does not apply." };
  }

  const { events, corrupt } = await readEvents(normalized);
  if (corrupt) {
    return {
      allowed: false,
      reason: "The consent record for this address could not be read, so marketing email was blocked.",
    };
  }
  const last = events.at(-1);
  if (last === undefined) {
    return {
      allowed: false,
      reason: "There is no marketing opt-in on record for this address.",
    };
  }
  if (last.type === "unsubscribe") {
    return {
      allowed: false,
      reason: `This address unsubscribed from marketing email on ${dayOf(last.at)}.`,
    };
  }
  return {
    allowed: true,
    reason: `This address opted in to marketing email on ${dayOf(last.at)}.`,
  };
}
