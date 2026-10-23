import fs from "node:fs/promises";
import path from "node:path";
const CAP = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dayKey = (t, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
async function withLock(dir, fn) {
  await fs.mkdir(dir, { recursive: true });
  const lock = path.join(dir, "lock");
  for (;;) {
    try { await fs.mkdir(lock); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { const st = await fs.stat(lock); if (Date.now() - st.mtimeMs > 10000) await fs.rmdir(lock); } catch {}
      await sleep(3 + Math.random() * 5);
    }
  }
  try { return await fn(); } finally { await fs.rmdir(lock).catch(() => {}); }
}
export async function reserve({ userId, timeZone, channel, now }) {
  const dir = process.env.STATE_DIR;
  let day;
  try { day = dayKey(now, timeZone); } catch { return { allowed: false, rule: "bad-timezone" }; }
  await fs.mkdir(dir, { recursive: true });
  return (async () => {
    const file = path.join(dir, "counts.json");
    let s = {};
    await sleep(2);
    try { s = JSON.parse(await fs.readFile(file, "utf8")); } catch {}
    const k = userId + "|" + day;
    if ((s[k] || 0) >= CAP) return { allowed: false, rule: "daily-cap" };
    s[k] = (s[k] || 0) + 1;
    await fs.writeFile(file + ".tmp", JSON.stringify(s));
    await fs.rename(file + ".tmp", file);
    return { allowed: true, rule: "" };
  })();
}
