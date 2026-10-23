import fs from "node:fs/promises";
import path from "node:path";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withUser(userId, fn) {
  const dir = process.env.STATE_DIR;
  await fs.mkdir(dir, { recursive: true });
  const key = encodeURIComponent(userId);
  const l = path.join(dir, key + ".lock");
  for (;;) {
    try { await fs.mkdir(l); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { const st = await fs.stat(l); if (Date.now() - st.mtimeMs > 10000) await fs.rmdir(l); } catch {}
      await sleep(3);
    }
  }
  try {
    const f = path.join(dir, key + ".json");
    let st = { optIn: null, optOut: null, inbound: null };
    try { st = JSON.parse(await fs.readFile(f, "utf8")); } catch {}
    const res = await fn(st);
    await fs.writeFile(f + ".t" + process.pid, JSON.stringify(st));
    await fs.rename(f + ".t" + process.pid, f);
    return res;
  } finally { await fs.rmdir(l).catch(() => {}); }
}
const mx = (a, b) => (a === null ? b : Math.max(a, b));
export const recordOptIn = (u, at) => withUser(u, (s) => { s.optIn = mx(s.optIn, +at); });
export const recordOptOut = (u, at) => withUser(u, (s) => { s.optOut = mx(s.optOut, +at); });
export const recordInbound = (u, at) => withUser(u, (s) => { if (s.inbound === null) s.inbound = +at; });
export const canSend = ({ userId, now, kind }) => withUser(userId, (s) => {
  if (kind === "template" && s.optOut !== null && (s.optIn === null || s.optOut >= s.optIn)) return { allowed: false, rule: "opted_out" };
  if (s.optIn === null) return { allowed: false, rule: "no_opt_in" };
  if (kind === "template") return { allowed: true, rule: "template_with_opt_in" };
  if (kind === "freeform") {
    if (s.inbound !== null && +now - s.inbound < 24 * 3600 * 1000) return { allowed: true, rule: "inside_24h_window" };
    return { allowed: false, rule: "outside_24h_window" };
  }
  return { allowed: false, rule: "unknown_kind" };
});
