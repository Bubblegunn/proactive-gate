import fs from "node:fs/promises";
import path from "node:path";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withLock(fn) {
  const dir = process.env.STATE_DIR;
  await fs.mkdir(dir, { recursive: true });
  const lock = path.join(dir, ".lock");
  for (;;) {
    try { await fs.mkdir(lock); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { const st = await fs.stat(lock); if (Date.now() - st.mtimeMs > 10000) await fs.rm(lock, { recursive: true, force: true }); } catch {}
      await sleep(2 + Math.random() * 8);
    }
  }
  try { return await fn(path.join(dir, "state.json")); }
  finally { await fs.rm(lock, { recursive: true, force: true }); }
}
async function readJson(f, dflt) { try { return JSON.parse(await fs.readFile(f, "utf8")); } catch { return dflt; } }
async function writeJson(f, v) { const t = f + "." + process.pid + ".tmp"; await fs.writeFile(t, JSON.stringify(v)); await fs.rename(t, f); }
function localDay(date, tz) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return f.format(date);
}
export async function reserveEmail({ userId, kind, timeZone, now }) {
  if (kind !== "marketing") return { allowed: true, blockedBy: null };
  return (async () => { const file = (await fs.mkdir(process.env.STATE_DIR, { recursive: true }), path.join(process.env.STATE_DIR, "state.json"));
    const s = await readJson(file, {});
    const day = localDay(now, timeZone);
    const e = s[userId];
    const c = e && e.day === day ? e.count : 0;
    if (c >= 3) return { allowed: false, blockedBy: "daily_marketing_cap" };
    s[userId] = { day, count: c + 1 };
    await sleep(5);
    await writeJson(file, s);
    return { allowed: true, blockedBy: null };
  })();
}
