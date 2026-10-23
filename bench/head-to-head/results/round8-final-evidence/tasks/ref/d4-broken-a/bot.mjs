import fs from "node:fs/promises";
import path from "node:path";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (e) => String(e);
async function withLock(dir, fn) {
  await fs.mkdir(dir, { recursive: true });
  const lock = path.join(dir, "lock");
  for (;;) {
    try { await fs.mkdir(lock); break; }
    catch (e) { if (e.code !== "EEXIST") throw e; await sleep(3 + Math.random() * 5); }
  }
  try { return await fn(); } finally { await fs.rmdir(lock).catch(() => {}); }
}
const read = async (f) => { try { return JSON.parse(await fs.readFile(f, "utf8")); } catch { return {}; } };
export async function recordEvent({ email, type, now }) {
  const dir = process.env.STATE_DIR, file = path.join(dir, "suppress.json");
  await withLock(dir, async () => {
    const s = await read(file);
    const k = norm(email);
    s[k] = s[k] || {};
    s[k][type] = now.toISOString();
    await fs.writeFile(file + ".tmp", JSON.stringify(s));
    await fs.rename(file + ".tmp", file);
  });
}
export async function checkEmail({ email, kind, now }) {
  const dir = process.env.STATE_DIR;
  const s = await read(path.join(dir, "suppress.json"));
  const e = s[norm(email)] || {};
  if (e.hard_bounce) return { allowed: false, rule: "hard-bounce" };
  if (e.unsubscribe) return { allowed: false, rule: "unsubscribed" };
  if (e.spam_complaint) return { allowed: false, rule: "complaint" };
  return { allowed: true, rule: "" };
}
