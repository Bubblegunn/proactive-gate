// Email suppression shared by all mail workers on one machine.
//
// State lives in an append-only log inside STATE_DIR. Every worker appends to
// the same file with O_APPEND and fsyncs before returning, so an unsubscribe
// survives a kill. Each worker reads only the bytes it has not yet seen, and
// the newest event per address decides the outcome.

import { randomUUID } from "node:crypto";
import { mkdir, open, stat } from "node:fs/promises";
import { join } from "node:path";

const LOG_NAME = "suppression.log";
const KINDS = new Set(["marketing", "receipt"]);

// Per-process read cache. The log only grows, so `offset` marks the end of
// the last fully read line.
let cache = { ino: null, offset: 0, state: new Map() };

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR environment variable is not set");
  return dir;
}

// Lowercase and trim. Returns null when the value is not usable as an address.
function normalizeEmail(email) {
  if (typeof email !== "string") return null;
  const e = email.trim().toLowerCase();
  const at = e.indexOf("@");
  if (at < 1 || at === e.length - 1 || e.includes(" ")) return null;
  return e;
}

function requireEmail(email) {
  const e = normalizeEmail(email);
  if (e === null) throw new TypeError(`not a valid email address: ${JSON.stringify(email)}`);
  return e;
}

async function appendEvent(event) {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const fh = await open(join(dir, LOG_NAME), "a");
  try {
    const buf = Buffer.from(JSON.stringify(event) + "\n", "utf8");
    let off = 0;
    while (off < buf.length) {
      const { bytesWritten } = await fh.write(buf, off, buf.length - off);
      off += bytesWritten;
    }
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function readRange(file, start, length) {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const { bytesRead } = await fh.read(buf, got, length - got, start + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return buf.subarray(0, got);
  } finally {
    await fh.close();
  }
}

// Returns Map<email, { op, at }> holding the newest event per address.
async function loadState() {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const file = join(dir, LOG_NAME);

  let st;
  try {
    st = await stat(file);
  } catch (err) {
    if (err.code === "ENOENT") return new Map();
    throw err;
  }

  // Replaced or truncated file: start over.
  if (cache.ino !== st.ino || st.size < cache.offset) {
    cache = { ino: st.ino, offset: 0, state: new Map() };
  }
  if (st.size === cache.offset) return cache.state;

  const bytes = await readRange(file, cache.offset, st.size - cache.offset);
  const text = bytes.toString("utf8");
  // Ignore a trailing partial line: another worker is still writing it.
  const lastNl = text.lastIndexOf("\n");
  if (lastNl < 0) return cache.state;

  const complete = text.slice(0, lastNl + 1);
  for (const line of complete.split("\n")) {
    if (line === "") continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      // Fail closed: skipping a corrupt unsubscribe could mail someone who opted out.
      throw new Error(`corrupt line in ${file}; refusing to send until it is repaired`);
    }
    cache.state.set(ev.email, { op: ev.op, at: ev.at });
  }
  cache.offset += Buffer.byteLength(complete, "utf8");
  return cache.state;
}

export async function unsubscribe(email) {
  const e = requireEmail(email);
  await appendEvent({
    v: 1,
    op: "unsubscribe",
    email: e,
    at: new Date().toISOString(),
    id: randomUUID(),
  });
}

// Call only when the person deliberately signs up again on the website.
export async function resubscribe(email) {
  const e = requireEmail(email);
  await appendEvent({
    v: 1,
    op: "resubscribe",
    email: e,
    at: new Date().toISOString(),
    id: randomUUID(),
  });
}

export async function mayEmail(email, kind, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  if (!KINDS.has(kind)) {
    return {
      allowed: false,
      reason: `Unknown email kind ${JSON.stringify(kind)}; use "marketing" or "receipt".`,
    };
  }
  const e = normalizeEmail(email);
  if (e === null) {
    return {
      allowed: false,
      reason: "The address is missing or not a valid email address, so nothing was sent.",
    };
  }

  // Receipts (order confirmations, shipping, password reset) are transactional.
  // A marketing opt-out does not block them under CAN-SPAM or GDPR.
  if (kind === "receipt") {
    return {
      allowed: true,
      reason: "Receipt or account email; marketing opt-outs do not block it.",
    };
  }

  const state = await loadState();
  const rec = state.get(e);
  if (rec && rec.op === "unsubscribe") {
    const day = rec.at.slice(0, 10);
    return {
      allowed: false,
      reason: `The recipient unsubscribed from marketing email on ${day} and has not signed up again since, so this marketing email was blocked.`,
    };
  }
  return { allowed: true, reason: "No unsubscribe on record; marketing email is allowed." };
}
