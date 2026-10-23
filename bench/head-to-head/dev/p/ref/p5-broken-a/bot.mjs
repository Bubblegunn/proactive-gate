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
const norm = (e) => String(e);
const empty = () => ({ unsub: {}, hard: {} });
export async function unsubscribe(email, now) {
  await withLock(async (file) => {
    const s = await readJson(file, empty());
    s.unsub[norm(email)] = now.toISOString();
    await writeJson(file, s);
  });
}
export async function recordBounce(email, type, now) {
  if (type !== "hard") return;
  await withLock(async (file) => {
    const s = await readJson(file, empty());
    s.hard[norm(email)] = now.toISOString();
    await writeJson(file, s);
  });
}
export async function mayEmail({ email, kind }) {
  return withLock(async (file) => {
    const s = await readJson(file, empty());
    const k = norm(email);
    if (s.hard[k]) return { allowed: false, blockedBy: "hard_bounce" };
    if (s.unsub[k]) return { allowed: false, blockedBy: "unsubscribed" };
    return { allowed: true, blockedBy: null };
  });
}
