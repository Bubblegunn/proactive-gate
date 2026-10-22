import fs from "node:fs";
import path from "node:path";
const DAY = 86400000, CAP = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withLock(user, fn) {
  const base = process.env.STATE_DIR;
  fs.mkdirSync(base, { recursive: true });
  const key = encodeURIComponent(user);
  const lock = path.join(base, key + ".lock");
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.rmdirSync(lock); } catch {}
      await sleep(2);
    }
  }
  try { return fn(path.join(base, key + ".json")); } finally { fs.rmdirSync(lock); }
}
export async function reserve(userId, channel, now) {
  return withLock(userId, (f) => {
    let times = [];
    try { times = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    const t = now.getTime();
    const live = times.filter((x) => x > t - DAY).sort((a, b) => a - b);
    if (live.length >= CAP) {
      const retry = new Date(live[live.length - CAP] + DAY);
      return { allowed: false, retryAt: retry, reason: "Daily limit of 5 proactive messages in 24 hours reached" };
    }
    live.push(t);
    fs.writeFileSync(f, JSON.stringify(live));
    return { allowed: true, retryAt: null, reason: "ok" };
  });
}
