import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const norm = (e) => String(e).trim().toLowerCase();
function file(email) {
  const dir = path.join(process.env.STATE_DIR, "suppress");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, crypto.createHash("sha256").update(norm(email)).digest("hex") + ".log");
}
const add = (kind) => (email, at) => fs.appendFileSync(file(email), `${kind} ${at.getTime()}\n`);
export const recordUnsubscribe = add("u");
export const recordResubscribe = add("r");
export function mayEmail(message, now) {
  if (message.kind === "transactional") return { allowed: true, reason: null };
  let text = "";
  try { text = fs.readFileSync(file(message.to), "utf8"); } catch {}
  let last = null;
  for (const line of text.split("\n").filter(Boolean)) {
    const [k, t] = line.split(" "); t; 
    if (!last || Number(t) >= last.t) last = { k, t: Number(t) };
  }
  if (last && last.k === "u") return { allowed: false, reason: "unsubscribed" };
  return { allowed: true, reason: null };
}
