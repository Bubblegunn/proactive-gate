import { mkdirSync, readFileSync, writeFileSync, renameSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

// Per-address record: the event with the latest provider time wins, so late
// or out-of-order webhooks cannot undo a newer decision. Same timestamp:
// unsubscribe wins (the safer outcome for the person).

function dir() {
  const d = process.env.STATE_DIR;
  if (!d) throw new Error("STATE_DIR is not set");
  mkdirSync(d, { recursive: true });
  return d;
}

// Accepts "a@b.c", " A@B.C ", "Name <a@b.c>", "mailto:a@b.c", '"x" <a@b.c> (comment)'.
function normalize(email) {
  let s = String(email ?? "").trim();
  const m = s.match(/<([^<>]*)>\s*[^<>]*$/);
  if (m) s = m[1];
  s = s.trim().replace(/^mailto:/i, "").replace(/^["'\s]+|["'\s]+$/g, "");
  return s.toLowerCase();
}

function file(d, addr) {
  return join(d, "optout-" + createHash("sha256").update(addr).digest("hex") + ".json");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withLock(path, fn) {
  const lock = path + ".lock";
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10000) rmdirSync(lock); // dead worker
      } catch {}
      if (Date.now() - start > 30000) throw new Error("state lock timeout");
      await sleep(5 + Math.random() * 15);
    }
  }
  try {
    return fn();
  } finally {
    try { rmdirSync(lock); } catch {}
  }
}

function read(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e; // unreadable state must not silently count as "no opt-out"
  }
}

async function record(email, at, type) {
  const t = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (!Number.isFinite(t)) throw new Error("invalid event time");
  const addr = normalize(email);
  if (!addr) throw new Error("invalid email");
  const path = file(dir(), addr);
  await withLock(path, () => {
    const cur = read(path);
    const win =
      !cur || t > cur.at || (t === cur.at && type === "unsubscribe" && cur.type !== "unsubscribe");
    if (!win) return;
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, JSON.stringify({ type, at: t }));
    renameSync(tmp, path);
  });
}

export function recordUnsubscribe(email, at) {
  return record(email, at, "unsubscribe");
}

export function recordResubscribe(email, at) {
  return record(email, at, "resubscribe");
}

export function mayEmail(message, now) {
  // Transactional (receipts, password resets) are exempt from opt-outs under
  // CAN-SPAM and are what people still expect after unsubscribing.
  if (message && message.kind === "transactional") return { allowed: true, reason: null };
  // Anything not clearly transactional is treated as marketing (the stricter rule).
  const addr = normalize(message && message.to);
  if (!addr) return { allowed: false, reason: "invalid_recipient" };
  const cur = read(file(dir(), addr));
  if (cur && cur.type === "unsubscribe") return { allowed: false, reason: "unsubscribed" };
  return { allowed: true, reason: null };
}
