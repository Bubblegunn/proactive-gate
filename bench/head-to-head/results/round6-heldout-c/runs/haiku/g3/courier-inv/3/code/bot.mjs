// Email consent state shared by all workers through STATE_DIR.
//
// Layout: STATE_DIR/suppression/<sha256 of normalised address>.jsonl
// One file per address, one JSON record per line, append-only.
// O_APPEND writes from concurrent workers are not interleaved, and the
// last record in file order is the current state. Nothing is rewritten,
// so a killed worker cannot leave a half-updated state file behind.
// A torn final line (process killed mid-write) is skipped on read.

import { createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

const KINDS = new Set(["marketing", "receipt"]);

function stateDir() {
  const dir = process.env.STATE_DIR;
  if (!dir) throw new Error("STATE_DIR environment variable is not set");
  return dir;
}

// Trim and lowercase. Addresses from checkout forms and mail clients
// often differ only in case or surrounding spaces.
function normalise(email) {
  if (typeof email !== "string") return null;
  const e = email.normalize("NFC").trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at < 1 || at === e.length - 1 || e.length > 254 || /\s/.test(e)) return null;
  return e;
}

function fileFor(normalised) {
  const hash = createHash("sha256").update(normalised).digest("hex");
  return path.join(stateDir(), "suppression", `${hash}.jsonl`);
}

async function readRecords(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const records = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Torn line from a killed writer. Ignore it.
    }
  }
  return records;
}

async function append(file, record) {
  await mkdir(path.dirname(file), { recursive: true });
  const fh = await open(file, "a");
  try {
    await fh.writeFile(JSON.stringify(record) + "\n");
    await fh.sync();
  } finally {
    await fh.close();
  }
}

function invalidAddress(email) {
  const err = new TypeError(`Not a usable email address: ${JSON.stringify(email)}`);
  err.code = "INVALID_EMAIL";
  return err;
}

// Record that the person no longer wants marketing email.
export async function unsubscribe(email) {
  const e = normalise(email);
  if (!e) throw invalidAddress(email);
  const at = new Date().toISOString();
  await append(fileFor(e), { action: "unsubscribe", email: e, at, pid: process.pid });
  return { email: e, status: "unsubscribed", at };
}

// Record that the person deliberately signed up again on the website.
// Only called from that signup flow. Any unsubscribe recorded before it is cancelled.
export async function resubscribe(email) {
  const e = normalise(email);
  if (!e) throw invalidAddress(email);
  const at = new Date().toISOString();
  await append(fileFor(e), { action: "resubscribe", email: e, at, pid: process.pid });
  return { email: e, status: "subscribed", at };
}

// Decide whether one email may be handed to the mail provider now.
// Marketing mail is blocked once the latest record for the address is an
// unsubscribe. Receipts (order confirmations, shipping, password resets)
// are transactional and are not blocked by a marketing opt-out.
// `now` is validated but not used for the decision: an unsubscribe takes effect
// immediately, regardless of clock differences between workers.
export async function mayEmail(email, kind, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return { allowed: false, reason: "The send time was not a valid date, so the email was not sent." };
  }
  if (!KINDS.has(kind)) {
    return { allowed: false, reason: `Unknown email kind "${kind}", so the email was not sent.` };
  }
  const e = normalise(email);
  if (!e) {
    return { allowed: false, reason: "The address is not a valid email address, so the email was not sent." };
  }

  const records = await readRecords(fileFor(e));
  const last = records.at(-1);

  if (kind === "receipt") {
    return { allowed: true, reason: "Receipts are transactional and are not blocked by a marketing opt-out." };
  }
  if (last && last.action === "unsubscribe") {
    const day = String(last.at).slice(0, 10);
    return {
      allowed: false,
      reason: `The recipient unsubscribed from marketing email on ${day} and has not signed up again, so no marketing email was sent.`,
    };
  }
  return { allowed: true, reason: "The recipient has not unsubscribed from marketing email." };
}
