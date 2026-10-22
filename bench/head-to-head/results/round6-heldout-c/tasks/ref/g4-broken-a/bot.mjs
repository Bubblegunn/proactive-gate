import fs from "node:fs";
import path from "node:path";
const DAY = 86400000, CAP = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function reserve(userId, channel, now) {
  fs.mkdirSync(process.env.STATE_DIR, { recursive: true });
  const f = path.join(process.env.STATE_DIR, encodeURIComponent(userId) + ".json");
  let times = [];
  try { times = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  await sleep(3); // no lock between read and write
  const t = now.getTime();
  const live = times.filter((x) => x > t - DAY).sort((a, b) => a - b);
  if (live.length >= CAP) return { allowed: false, retryAt: new Date(live[live.length - CAP] + DAY), reason: "24h limit reached" };
  live.push(t);
  fs.writeFileSync(f, JSON.stringify(live));
  return { allowed: true, retryAt: null, reason: "ok" };
}
