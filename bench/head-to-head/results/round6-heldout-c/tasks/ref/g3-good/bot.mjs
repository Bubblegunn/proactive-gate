import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const norm = (e) => String(e).trim().toLowerCase();
const file = (e) => {
  const d = path.join(process.env.STATE_DIR, "unsub");
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, crypto.createHash("sha1").update(norm(e)).digest("hex"));
};
export async function unsubscribe(email) { fs.writeFileSync(file(email), norm(email)); }
export async function resubscribe(email) { fs.rmSync(file(email), { force: true }); }
export async function mayEmail(email, kind, now) {
  if (kind !== "marketing") return { allowed: true, reason: "Transactional mail is not affected by unsubscribes" };
  if (fs.existsSync(file(email))) return { allowed: false, reason: "Recipient has unsubscribed from marketing email" };
  return { allowed: true, reason: "No unsubscribe on record" };
}
