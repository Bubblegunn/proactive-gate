import fs from "node:fs";
import path from "node:path";
const CAP = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withLock(user, fn) {
  const base = process.env.STATE_DIR;
  fs.mkdirSync(base, { recursive: true });
  const key = encodeURIComponent(user);
  const lock = path.join(base, key + ".lock");
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) { if (e.code !== "EEXIST") throw e; await sleep(2); }
  }
  try { return fn(path.join(base, key + ".json")); } finally { fs.rmdirSync(lock); }
}
// counts per UTC calendar day instead of a sliding 24 hours
export async function reserve(userId, channel, now) {
  return withLock(userId, (f) => {
    let times = [];
    try { times = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    const day = now.toISOString().slice(0, 10);
    const live = times.filter((x) => new Date(x).toISOString().slice(0, 10) === day);
    if (live.length >= CAP) {
      const next = new Date(day + "T00:00:00Z");
      next.setUTCDate(next.getUTCDate() + 1);
      return { allowed: false, retryAt: next, reason: "Daily limit reached" };
    }
    times.push(now.getTime());
    fs.writeFileSync(f, JSON.stringify(times));
    return { allowed: true, retryAt: null, reason: "ok" };
  });
}
