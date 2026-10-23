import fs from "node:fs/promises";
import path from "node:path";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dayKey = (d, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
async function withLock(dir, key, fn) {
  const l = path.join(dir, key + ".lock");
  for (;;) {
    try { await fs.mkdir(l); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { const st = await fs.stat(l); if (Date.now() - st.mtimeMs > 10000) await fs.rmdir(l); } catch {}
      await sleep(3);
    }
  }
  try { return await fn(); } finally { await fs.rmdir(l).catch(() => {}); }
}
export async function reservePush({ userId, timeZone, now, category }) {
  if (category === "transactional") return { allowed: true, rule: "transactional_exempt" };
  const dir = process.env.STATE_DIR;
  await fs.mkdir(dir, { recursive: true });
  const key = encodeURIComponent(userId);
  return withLock(dir, key, async () => {
    const f = path.join(dir, key + ".json");
    let st = { day: "", count: 0 };
    try { st = JSON.parse(await fs.readFile(f, "utf8")); } catch {}
    const day = dayKey(now, timeZone);
    if (st.day !== day) st = { day, count: 0 };
    if (st.count >= 3) return { allowed: false, rule: "daily_promotional_cap" };
    st.count++;
    await fs.writeFile(f + ".tmp" + process.pid, JSON.stringify(st));
    await fs.rename(f + ".tmp" + process.pid, f);
    return { allowed: true, rule: "within_cap" };
  });
}
