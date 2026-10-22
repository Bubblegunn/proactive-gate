// Marketing suppression list shared by all worker processes via STATE_DIR.
//
// Storage: one append-only JSON-lines file, STATE_DIR/suppression.log.
// Each line is one event { t: "unsub" | "resub", k: canonical address, at: epoch ms }.
// The current state of an address is the event with the latest `at`
// (provider clock), so arrival order does not matter. On an exact tie,
// "unsub" wins (the conservative choice).
//
// Transactional mail (receipts, password resets) is never blocked by an
// unsubscribe. CAN-SPAM exempts transactional messages from opt-out.

import { mkdir, open } from "node:fs/promises";
import path from "node:path";

const LOG_NAME = "suppression.log";

// Per-process read cache: dir -> { offset, index }. Each process reads only
// the bytes appended since its last read, so other workers' writes are seen.
const views = new Map();

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR is not set");
  return dir;
}

function toEpochMs(value, name) {
  const ms = value instanceof Date ? value.getTime() : NaN;
  if (Number.isNaN(ms)) throw new TypeError(`${name} must be a valid Date`);
  return ms;
}

// Maps an address (plain, "Name <addr>", or mailto:) to one key per mailbox.
// Gmail ignores dots and "+tag" suffixes, so those variants share a key.
// Plus-tags are stripped on every domain: over-suppressing is safer than
// mailing someone who opted out under another alias.
function canonicalAddress(input) {
  if (typeof input !== "string") return null;
  let s = input.trim();
  const angle = s.match(/<([^<>]+)>\s*$/);
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, "").replace(/^"(.*)"$/, "$1").trim();
  s = s.normalize("NFKC").toLowerCase();
  if (/\s/.test(s)) return null;

  const at = s.lastIndexOf("@");
  if (at <= 0 || at === s.length - 1) return null;
  let local = s.slice(0, at);
  let domain = s.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  local = local.split("+")[0];
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  if (!local || !domain.includes(".")) return null;
  return `${local}@${domain}`;
}

function applyEvent(index, ev) {
  if (typeof ev.k !== "string" || typeof ev.at !== "number") return;
  const cur = index.get(ev.k);
  if (!cur || ev.at > cur.at || (ev.at === cur.at && ev.t === "unsub")) {
    index.set(ev.k, { t: ev.t, at: ev.at });
  }
}

async function readNewEvents(dir) {
  let view = views.get(dir);
  if (!view) {
    view = { offset: 0, index: new Map() };
    views.set(dir, view);
  }

  let fh;
  try {
    fh = await open(path.join(dir, LOG_NAME), "r");
  } catch (err) {
    if (err.code === "ENOENT") return view;
    throw err;
  }

  try {
    const { size } = await fh.stat();
    if (size < view.offset) {
      // The log was replaced or truncated; start over.
      view = { offset: 0, index: new Map() };
      views.set(dir, view);
    }
    const want = size - view.offset;
    if (want <= 0) return view;

    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const { bytesRead } = await fh.read(buf, got, want - got, view.offset + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }

    // Consume only complete lines. A partial last line belongs to a write
    // still in progress and is picked up on the next read.
    const end = buf.subarray(0, got).lastIndexOf(0x0a);
    if (end < 0) return view;
    for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue; // unreadable line; skip rather than fail closed for everyone
      }
      applyEvent(view.index, ev);
    }
    view.offset += end + 1;
    return view;
  } finally {
    await fh.close();
  }
}

async function appendEvent(ev) {
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const line = Buffer.from(JSON.stringify(ev) + "\n", "utf8");
  // "a" mode: each write lands at the end of the file, even with other writers.
  const fh = await open(path.join(dir, LOG_NAME), "a");
  try {
    let off = 0;
    while (off < line.length) {
      const { bytesWritten } = await fh.write(line, off, line.length - off);
      off += bytesWritten;
    }
    // Opt-outs must survive a crash, so flush to disk before returning.
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function record(t, email, at) {
  const k = canonicalAddress(email);
  if (!k) throw new TypeError("email is not a valid address");
  const ms = toEpochMs(at, "at");
  await appendEvent({ t, k, at: ms, recorded: Date.now() });
}

export async function recordUnsubscribe(email, at) {
  await record("unsub", email, at);
}

export async function recordResubscribe(email, at) {
  await record("resub", email, at);
}

export async function mayEmail(message, now) {
  toEpochMs(now, "now");
  if (!message || typeof message !== "object") {
    throw new TypeError("message must be an object");
  }

  if (message.kind === "transactional") {
    return { allowed: true, reason: null };
  }
  if (message.kind !== "marketing") {
    return { allowed: false, reason: "unknown_message_kind" };
  }

  const k = canonicalAddress(message.to);
  if (!k) return { allowed: false, reason: "invalid_address" };

  const view = await readNewEvents(stateDir());
  const rec = view.index.get(k);
  if (rec && rec.t === "unsub") {
    return { allowed: false, reason: "unsubscribed" };
  }
  return { allowed: true, reason: null };
}
