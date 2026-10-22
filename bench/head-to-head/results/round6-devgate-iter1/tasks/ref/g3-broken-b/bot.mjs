import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
function file(email) {
  const dir = path.join(process.env.STATE_DIR, "suppress");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, crypto.createHash("sha256").update(String(email)).digest("hex") + ".txt");
}
export const recordUnsubscribe = (email) => fs.writeFileSync(file(email), "u");
export const recordResubscribe = (email) => fs.writeFileSync(file(email), "r");
export function mayEmail(message) {
  let s = ""; try { s = fs.readFileSync(file(message.to), "utf8"); } catch {}
  return s === "u" ? { allowed: false, reason: "unsubscribed" } : { allowed: true, reason: null };
}
