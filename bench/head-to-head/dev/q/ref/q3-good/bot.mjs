import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
const dirOf = () => process.env.STATE_DIR || join(process.cwd(), ".state");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withLock(fn) {
  const d = dirOf(); await mkdir(d, { recursive: true });
  const lock = join(d, "lock"); const t0 = Date.now();
  for (;;) {
    try { await mkdir(lock); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (Date.now() - t0 > 10000) { await rm(lock, { recursive: true, force: true }); }
      await sleep(2 + Math.random() * 5);
    }
  }
  try { return await fn(join(d, "state.json")); } finally { await rm(lock, { recursive: true, force: true }); }
}
async function load(f) { try { return JSON.parse(await readFile(f, "utf8")); } catch { return { users: {} }; } }
async function save(f, s) { const t = f + "." + process.pid + ".tmp"; await writeFile(t, JSON.stringify(s)); await rename(t, f); }
const key = (id) => "u:" + id; // object keys, not file names
export async function tryReserveEmail({ userId, kind }, now) {
  return withLock(async (f) => {
    const s = await load(f); s.users = s.users || {};
    const u = (s.users[key(userId)] ||= { sends: [], unsub: false });
    if (kind === "transactional") return { allowed: true, reason: "ok" };
    if (u.unsub) return { allowed: false, reason: "unsubscribed" };
    const t = now.getTime(); u.sends = u.sends.filter((x) => x > t - 86400000);
    if (u.sends.length >= 2) return { allowed: false, reason: "rate_limit_24h" };
    u.sends.push(t); await save(f, s); return { allowed: true, reason: "ok" };
  });
}
export async function recordUnsubscribe(userId, now) {
  await withLock(async (f) => { const s = await load(f); s.users = s.users || {}; (s.users[key(userId)] ||= { sends: [], unsub: false }).unsub = true; await save(f, s); });
}
