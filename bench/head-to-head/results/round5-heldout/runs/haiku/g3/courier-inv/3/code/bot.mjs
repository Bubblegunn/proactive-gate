// Opt-out ledger for marketing email, shared by every worker through STATE_DIR.
//
// Storage: an append-only NDJSON log at $STATE_DIR/email-optout-events.ndjson.
// Each record is one write, fsynced before the call resolves, so a restarted
// worker or another worker sees it. A record torn by a crash is skipped on read.
//
// Rules:
// - An unsubscribe blocks marketing mail. It never blocks transactional mail
//   (receipts, password resets).
// - A resubscribe lifts the block only when it is later than the latest unsubscribe.
// - Events are ordered by the provider's `at`, not by arrival. On a tie, unsubscribe wins.
// - Addresses match by canonical key: case-insensitive, display names and mailto:
//   stripped, +tags removed, and dots removed for gmail.com / googlemail.com.
// - Unknown kinds, invalid recipients and unreadable state fail closed.

import { mkdir, open, stat } from "node:fs/promises";
import { join } from "node:path";

const LOG_NAME = "email-optout-events.ndjson";
const KINDS = new Set(["marketing", "transactional"]);
const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

// Per-process view of the log. The log only grows, so each sync parses only new bytes.
let view = freshView(null);
// Serializes syncs inside one process so two calls never apply the same bytes twice.
let chain = Promise.resolve();

export async function recordUnsubscribe(email, at) {
  await append("unsubscribe", email, at);
}

export async function recordResubscribe(email, at) {
  await append("resubscribe", email, at);
}

export async function mayEmail(message, now) {
  const nowMs = toMs(now, "now");
  const kind = message?.kind;
  if (!KINDS.has(kind)) return deny("invalid_kind");

  let key;
  try {
    key = canonicalKey(message.to);
  } catch {
    return deny("invalid_recipient");
  }

  // Receipts and password resets go out regardless of marketing opt-outs.
  if (kind === "transactional") return allow();

  let optedOut;
  try {
    await sync();
    optedOut = isOptedOut(key, nowMs);
  } catch {
    return deny("suppression_state_unavailable");
  }
  return optedOut ? deny("unsubscribed") : allow();
}

function allow() {
  return { allowed: true, reason: null };
}

function deny(reason) {
  return { allowed: false, reason };
}

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR is not set");
  return dir;
}

function freshView(path) {
  return { path, offset: 0, keys: new Map() };
}

function serialize(task) {
  const run = chain.then(task);
  chain = run.catch(() => {});
  return run;
}

function toMs(value, name) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${name} must be a valid Date`);
  }
  return value.getTime();
}

// Maps any spelling of an address to one key per mailbox.
function canonicalKey(input) {
  if (typeof input !== "string") throw new TypeError("email must be a string");
  let s = input.normalize("NFKC").trim();
  if (/^mailto:/i.test(s)) s = s.replace(/^mailto:/i, "").replace(/\?.*$/, "");
  const angled = s.match(/<([^<>]*)>/);
  if (angled) s = angled[1].trim();

  const at = s.lastIndexOf("@");
  if (at < 1 || at === s.length - 1 || /\s/.test(s)) {
    throw new TypeError(`not an email address: ${input}`);
  }

  let local = s.slice(0, at).toLowerCase();
  let domain = s.slice(at + 1).toLowerCase().replace(/\.$/, "");
  local = local.split("+")[0] || local;
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\./g, "");
    domain = "gmail.com";
  }
  if (!local || !domain.includes(".")) {
    throw new TypeError(`not an email address: ${input}`);
  }
  return `${local}@${domain}`;
}

async function append(type, email, at) {
  const atMs = toMs(at, "at");
  canonicalKey(email); // reject bad addresses before they reach the log
  const dir = stateDir();
  await mkdir(dir, { recursive: true });
  const fh = await open(join(dir, LOG_NAME), "a");
  try {
    // The leading newline ends any record a crash left half-written.
    await fh.appendFile(`\n${JSON.stringify({ type, a: email, at: atMs })}\n`);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

function sync() {
  return serialize(async () => {
    const path = join(stateDir(), LOG_NAME);
    if (view.path !== path) view = freshView(path);

    let size;
    try {
      size = (await stat(path)).size;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      view = freshView(path);
      return;
    }
    if (size < view.offset) view = freshView(path); // file was replaced or truncated
    if (size === view.offset) return;

    const fh = await open(path, "r");
    try {
      const want = size - view.offset;
      const buf = Buffer.alloc(want);
      const { bytesRead } = await fh.read(buf, 0, want, view.offset);
      const end = buf.subarray(0, bytesRead).lastIndexOf(0x0a);
      if (end < 0) return; // no complete record yet
      for (const line of buf.subarray(0, end + 1).toString("utf8").split("\n")) {
        apply(line);
      }
      view.offset += end + 1;
    } finally {
      await fh.close();
    }
  });
}

function apply(line) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return; // blank line or a record torn by a crash
  }
  if (!ev || typeof ev.a !== "string" || !Number.isFinite(ev.at)) return;
  if (ev.type !== "unsubscribe" && ev.type !== "resubscribe") return;

  let key;
  try {
    key = canonicalKey(ev.a);
  } catch {
    return;
  }
  let entry = view.keys.get(key);
  if (!entry) {
    entry = { unsub: [], resub: [] };
    view.keys.set(key, entry);
  }
  (ev.type === "unsubscribe" ? entry.unsub : entry.resub).push(ev.at);
}

// State as of `nowMs`: the latest unsubscribe is not superseded by a resubscribe
// that happened at or before `nowMs`. Unsubscribes count even when dated after
// `nowMs` (provider clock skew), which errs toward blocking.
function isOptedOut(key, nowMs) {
  const entry = view.keys.get(key);
  if (!entry || entry.unsub.length === 0) return false;

  let lastUnsub = -Infinity;
  for (const t of entry.unsub) if (t > lastUnsub) lastUnsub = t;

  let lastResub = -Infinity;
  for (const t of entry.resub) if (t <= nowMs && t > lastResub) lastResub = t;

  return lastUnsub >= lastResub;
}
