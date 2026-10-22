import fs from "node:fs/promises";
import path from "node:path";
const norm = (e) => String(e).trim().toLowerCase();
const f = () => path.join(process.env.STATE_DIR, "unsub.json");
async function read() { try { return JSON.parse(await fs.readFile(f(), "utf8")); } catch { return {}; } }
async function write(o) { await fs.mkdir(process.env.STATE_DIR, { recursive: true }); await fs.writeFile(f(), JSON.stringify(o)); }
export async function recordUnsubscribe(email, at) {
  const o = await read();
  if (!o[norm(email)] || o[norm(email)].t <= at.getTime()) o[norm(email)] = { k: "u", t: at.getTime() };
  await write(o);
}
export async function recordResubscribe(email, at) {
  const o = await read();
  if (!o[norm(email)] || o[norm(email)].t <= at.getTime()) o[norm(email)] = { k: "r", t: at.getTime() };
  await write(o);
}
export async function mayEmail(message) {
  if (message.kind === "transactional") return { allowed: true, reason: null };
  const o = await read();
  const e = o[norm(message.to)];
  return e && e.k === "u" ? { allowed: false, reason: "unsubscribed" } : { allowed: true, reason: null };
}
