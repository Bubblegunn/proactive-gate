import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
const dirOf = () => process.env.STATE_DIR || join(process.cwd(), ".state");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withLock(fn) {
  const d = dirOf(); await mkdir(d, { recursive: true }); const lock = join(d, "lock");
  for (;;) { try { await mkdir(lock); break; } catch (e) { if (e.code !== "EEXIST") throw e; await sleep(3); } }
  try { return await fn(d); } finally { await rm(lock, { recursive: true, force: true }); }
}
async function load(f) { try { return JSON.parse(await readFile(f, "utf8")); } catch { return { sends: [], unsub: false }; } }
export async function tryReserveEmail({ userId, kind }, now) {
  return withLock(async (d) => {
    const f = join(d, userId + ".json"); const u = await load(f);
    if (kind === "transactional") return { allowed: true, reason: "ok" };
    if (u.unsub) return { allowed: false, reason: "unsubscribed" };
    const day = now.toISOString().slice(0, 10); u.sends = u.sends.filter((x) => x === day);
    if (u.sends.length >= 2) return { allowed: false, reason: "rate_limit" };
    u.sends.push(day); await writeFile(f, JSON.stringify(u)); return { allowed: true, reason: "ok" };
  });
}
export async function recordUnsubscribe(userId) {
  await withLock(async (d) => { const f = join(d, userId + ".json"); const u = await load(f); u.unsub = true; await writeFile(f, JSON.stringify(u)); });
}
