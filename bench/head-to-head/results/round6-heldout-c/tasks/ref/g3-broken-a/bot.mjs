import fs from "node:fs";
import path from "node:path";
const f = () => { fs.mkdirSync(process.env.STATE_DIR, { recursive: true }); return path.join(process.env.STATE_DIR, "unsub.json"); };
const read = () => { try { return JSON.parse(fs.readFileSync(f(), "utf8")); } catch { return []; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function unsubscribe(email) {
  const list = read();
  await sleep(5);
  if (!list.includes(email)) list.push(email);
  fs.writeFileSync(f(), JSON.stringify(list));
}
export async function resubscribe(email) { fs.writeFileSync(f(), JSON.stringify(read().filter((x) => x !== email))); }
export async function mayEmail(email, kind, now) {
  if (read().includes(email)) return { allowed: false, reason: "Unsubscribed" };
  return { allowed: true, reason: "ok" };
}
