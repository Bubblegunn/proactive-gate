// Opt-out and re-subscribe gate for the outbound email queue.
//
// State lives in $STATE_DIR/suppression/<sha256 of canonical address>/, one
// small JSON file per event. Every worker reads and writes the same files, so
// any worker can record an event and any worker can enforce it, including
// after a restart. Each file is written to a temp name and renamed into place,
// so readers never see a half-written event.
//
// Decision rule: for each person, the event with the latest provider
// timestamp (`at`) wins. If two events share a timestamp, the unsubscribe wins.
// Arrival order does not matter, so a late "unsubscribe" that happened after a
// "re-subscribe" still blocks, and a late, older "re-subscribe" cannot undo a
// newer unsubscribe.
//
// Rules enforced by mayEmail:
// - Marketing mail stops once the latest event for the person is an unsubscribe.
//   CAN-SPAM (15 U.S.C. 7704) requires honoring an opt-out, and Gmail/Yahoo
//   bulk-sender rules expect the same, so we stop immediately rather than wait
//   for a grace period.
// - Transactional mail (order receipts, password resets) is never blocked by an
//   opt-out. The recipient expects it, and CAN-SPAM exempts it from opt-out.
// - If the store cannot be read, marketing mail is refused (fail closed).
//   Transactional mail does not depend on the store, so it still goes out.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const KIND_UNSUBSCRIBE = "unsubscribe";
const KIND_RESUBSCRIBE = "resubscribe";

function storeRoot() {
  const stateDir = process.env.STATE_DIR;
  if (!stateDir) throw new Error("STATE_DIR is not set");
  return join(stateDir, "suppression");
}

// Maps one address to the person behind it, so opt-outs cannot be dodged by
// case, display name, plus-tags, Gmail dots, or googlemail.com.
export function canonicalEmail(input) {
  if (typeof input !== "string") throw new TypeError("email must be a string");
  let s = input.trim();
  const angle = s.match(/<([^<>]+)>/); // "Name" <addr> as seen in a header
  if (angle) s = angle[1].trim();
  s = s.replace(/^mailto:/i, "").normalize("NFKC").toLowerCase();
  if (/\s/.test(s)) throw new TypeError("email contains whitespace");
  const at = s.lastIndexOf("@");
  if (at <= 0 || at === s.length - 1) throw new TypeError("email has no local part or domain");
  let local = s.slice(0, at);
  let domain = s.slice(at + 1);
  local = local.split("+")[0]; // a+news@x and a@x are the same mailbox
  if (local === "") throw new TypeError("email has an empty local part");
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, ""); // Gmail ignores dots
  return `${local}@${domain}`;
}

function toMillis(at) {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new TypeError("at must be a valid Date");
  }
  return at.getTime();
}

function keyDir(canon) {
  return join(storeRoot(), createHash("sha256").update(canon).digest("hex"));
}

async function writeEvent(kind, email, at) {
  const canon = canonicalEmail(email);
  const ms = toMillis(at);
  const dir = keyDir(canon);
  await mkdir(dir, { recursive: true });

  // The file name depends only on the event content, so a duplicate delivery
  // of the same webhook overwrites the file with identical bytes.
  const finalPath = join(dir, `${ms}-${kind}.json`);
  const tmpPath = join(dir, `.${ms}-${kind}.${process.pid}.${randomUUID()}.tmp`);
  const body = JSON.stringify({ email: canon, kind, at: ms });
  await writeFile(tmpPath, body);
  await rename(tmpPath, finalPath);
}

function isLater(candidate, current) {
  if (candidate.at !== current.at) return candidate.at > current.at;
  return candidate.kind === KIND_UNSUBSCRIBE && current.kind !== KIND_UNSUBSCRIBE;
}

// Returns the winning event for an address, or null if there are none.
async function currentDecision(canon) {
  const dir = keyDir(canon);
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  let best = null;
  for (const name of names) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const event = JSON.parse(await readFile(join(dir, name), "utf8"));
    if (!best || isLater(event, best)) best = event;
  }
  return best;
}

export async function recordUnsubscribe(email, at) {
  await writeEvent(KIND_UNSUBSCRIBE, email, at);
}

export async function recordResubscribe(email, at) {
  await writeEvent(KIND_RESUBSCRIBE, email, at);
}

// `now` is accepted for the queue's API. The decision depends only on event
// timestamps, so an unsubscribe that is already stored blocks mail even when
// it was queued before the unsubscribe happened.
export async function mayEmail(message, now) {
  const deny = (reason) => ({ allowed: false, reason });
  const allow = () => ({ allowed: true, reason: null });

  if (!message || typeof message !== "object") return deny("invalid_message");
  if (message.kind === "transactional") return allow();
  if (message.kind !== "marketing") return deny("unknown_kind");

  let canon;
  try {
    canon = canonicalEmail(message.to);
  } catch {
    return deny("invalid_recipient");
  }

  let decision;
  try {
    decision = await currentDecision(canon);
  } catch {
    return deny("suppression_check_failed");
  }
  if (decision && decision.kind === KIND_UNSUBSCRIBE) return deny("unsubscribed");
  return allow();
}
