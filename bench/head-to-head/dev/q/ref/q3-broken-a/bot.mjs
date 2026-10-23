import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const dirOf = () => process.env.STATE_DIR || join(process.cwd(), ".state");
async function load(f) { try { return JSON.parse(await readFile(f, "utf8")); } catch { return { users: {} }; } }
export async function tryReserveEmail({ userId, kind }, now) {
  const d = dirOf(); await mkdir(d, { recursive: true }); const f = join(d, "state.json");
  const s = await load(f); const u = (s.users["u:" + userId] ||= { sends: [], unsub: false });
  if (kind === "transactional") return { allowed: true, reason: "ok" };
  if (u.unsub) return { allowed: false, reason: "unsubscribed" };
  const t = now.getTime(); u.sends = u.sends.filter((x) => x > t - 86400000);
  if (u.sends.length >= 2) return { allowed: false, reason: "rate_limit_24h" };
  u.sends.push(t); await writeFile(f, JSON.stringify(s)); return { allowed: true, reason: "ok" };
}
export async function recordUnsubscribe(userId) {
  const d = dirOf(); await mkdir(d, { recursive: true }); const f = join(d, "state.json");
  const s = await load(f); (s.users["u:" + userId] ||= { sends: [], unsub: false }).unsub = true; await writeFile(f, JSON.stringify(s));
}
