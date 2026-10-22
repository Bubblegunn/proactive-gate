import { mkdir, writeFile, rename, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

// State layout: $STATE_DIR/optout/<sha256(address)>/<providerMs>_<u|r>_<uuid>
// Every event is its own file, created with temp file + rename, so workers never
// overwrite each other and the result does not depend on arrival order.

const stateDir = () => {
  const d = process.env.STATE_DIR;
  if (!d) throw new Error("STATE_DIR is not set");
  return d;
};

// Accepts "<EMAIL>", " <EMAIL> ", "Name <<EMAIL>>", "<<EMAIL>>", "mailto:<EMAIL>".
export function normalizeEmail(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  const m = s.match(/<([^<>]*)>\s*$/);
  if (m) s = m[1].trim();
  s = s.replace(/^mailto:/i, "").trim().toLowerCase();
  if (!/^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(s)) return null;
  return s;
}

const addrDir = (email) =>
  path.join(stateDir(), "optout", createHash("sha256").update(email).digest("hex"));

async function record(type, email, at) {
  const addr = normalizeEmail(email);
  if (!addr) throw new Error("invalid email address");
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new Error("invalid event time");
  const dir = addrDir(addr);
  await mkdir(dir, { recursive: true });
  const id = randomUUID();
  const tmp = path.join(dir, `.tmp-${id}`);
  await writeFile(tmp, JSON.stringify({ type, at: at.getTime() }), { flag: "wx" });
  await rename(tmp, path.join(dir, `${at.getTime()}_${type}_${id}`));
}

export const recordUnsubscribe = (email, at) => record("u", email, at);
export const recordResubscribe = (email, at) => record("r", email, at);

async function events(addr) {
  let names;
  try {
    names = await readdir(addrDir(addr));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  return names
    .filter((n) => !n.startsWith(".tmp-"))
    .map((n) => {
      const [ms, type] = n.split("_");
      return { at: Number(ms), type };
    });
}

export async function mayEmail(message, now) {
  const kind = message?.kind;
  // Transactional (receipts, password resets) is exempt from opt-outs under CAN-SPAM.
  if (kind === "transactional") return { allowed: true, reason: null };
  // Any other kind is treated as marketing.
  const addr = normalizeEmail(message?.to);
  if (!addr) return { allowed: false, reason: "invalid_address" };
  const t = now instanceof Date && !Number.isNaN(now.getTime()) ? now.getTime() : Date.now();
  let last = null;
  for (const e of await events(addr)) {
    // A resubscribe stamped after "now" is not effective yet; unsubscribes always count.
    if (e.type === "r" && e.at > t) continue;
    // Latest provider time wins; on a tie the unsubscribe wins.
    if (!last || e.at > last.at || (e.at === last.at && e.type === "u")) last = e;
  }
  if (last && last.type === "u") return { allowed: false, reason: "unsubscribed" };
  return { allowed: true, reason: null };
}
