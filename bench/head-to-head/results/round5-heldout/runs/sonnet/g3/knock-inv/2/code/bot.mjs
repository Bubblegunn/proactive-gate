// Opt-out gate for marketing email (CAN-SPAM 15 U.S.C. 7704(a)(4); Gmail/Yahoo bulk sender rules).
//
// Rules:
// - An unsubscribe blocks marketing email to that address, with effect from the next check
//   (no 10-business-day delay; Gmail/Yahoo expect opt-outs honored within 2 days).
// - Transactional email (receipts, password resets) is not marketing and is never blocked
//   by an unsubscribe. CAN-SPAM exempts transactional or relationship messages.
// - Events can arrive late and out of order. The event with the latest provider time wins.
//   If an unsubscribe and a resubscribe have the same time, the unsubscribe wins.
// - State is an append-only log per address in STATE_DIR. One O_APPEND write per event is
//   atomic across processes, so concurrent workers need no lock and no event is lost.
//   State is derived from the whole log on each check, so it is the same in every worker
//   and after every restart.

import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR is not set");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Accepts "Name <a@b.c>", "<a@b.c>", "mailto:a@b.c", with spaces or quotes. Returns null if no address.
function normalize(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  const angle = s.match(/<([^<>]*)>\s*$/);
  if (angle) s = angle[1];
  s = s.trim().replace(/^mailto:/i, "").replace(/^["'\s]+|["'\s]+$/g, "");
  s = s.split("?")[0].normalize("NFKC").toLowerCase();
  const at = s.lastIndexOf("@");
  if (at < 1 || at === s.length - 1 || /\s/.test(s)) return null;
  return s;
}

function fileFor(email) {
  const name = createHash("sha256").update(email).digest("hex");
  return join(stateDir(), `${name}.log`);
}

function toMs(at) {
  const ms = at instanceof Date ? at.getTime() : new Date(at).getTime();
  if (!Number.isFinite(ms)) throw new Error("invalid event time");
  return ms;
}

function record(kind, email, at) {
  const addr = normalize(email);
  if (!addr) throw new Error("invalid email address");
  const line = `${kind} ${toMs(at)}\n`;
  const fd = openSync(fileFor(addr), "a");
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function recordUnsubscribe(email, at) {
  record("U", email, at);
}

export function recordResubscribe(email, at) {
  record("R", email, at);
}

function isUnsubscribed(addr) {
  let text;
  try {
    text = readFileSync(fileFor(addr), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
  let lastU = -Infinity;
  let lastR = -Infinity;
  for (const line of text.split("\n")) {
    const m = line.match(/^([UR]) (-?\d+)$/); // ignore a torn or partial line
    if (!m) continue;
    const t = Number(m[2]);
    if (m[1] === "U") lastU = Math.max(lastU, t);
    else lastR = Math.max(lastR, t);
  }
  return lastU >= lastR && lastU !== -Infinity;
}

export function mayEmail(message, now) {
  if (message && message.kind === "transactional") return { allowed: true, reason: null };
  // Anything that is not clearly transactional is treated as marketing.
  const addr = normalize(message && message.to);
  if (!addr) return { allowed: false, reason: "invalid_address" };
  if (isUnsubscribed(addr)) return { allowed: false, reason: "unsubscribed" };
  return { allowed: true, reason: null };
}
