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
const GAP = 2 * 3600e3;
const WEEK = 7 * 24 * 3600e3;
export async function requestSend({ userId, now }) {
  return withLock(async (file) => {
    const s = await readJson(file, {});
    const ts = now.getTime();
    const list = (s[userId] || []).slice().sort((a, b) => a - b);
    let gapUntil = 0, weekUntil = 0;
    const last = list.length ? list[list.length - 1] : null;
    if (last !== null && ts - last < GAP) gapUntil = last + GAP;
    const inWeek = list.filter((t) => t > ts - WEEK);
    if (inWeek.length >= 4) weekUntil = inWeek[inWeek.length - 4] + WEEK;
    if (gapUntil || weekUntil) {
      list.push(ts);
      s[userId] = list;
      await writeJson(file, s);
      return { allowed: false, blockedBy: weekUntil ? "weekly_cap" : "min_gap", retryAt: new Date(ts + GAP).toISOString() };
    }
    list.push(ts);
    s[userId] = list;
    await writeJson(file, s);
    return { allowed: true, blockedBy: null, retryAt: null };
  });
}
