import fs from "node:fs/promises";
import path from "node:path";
export async function reservePush({ userId, timeZone, now, category }) {
  if (category === "transactional") return { allowed: true, rule: "transactional_exempt" };
  const dir = process.env.STATE_DIR;
  await fs.mkdir(dir, { recursive: true });
  const f = path.join(dir, encodeURIComponent(userId) + ".json");
  let st = { day: "", count: 0 };
  try { st = JSON.parse(await fs.readFile(f, "utf8")); } catch {}
  const day = now.toISOString().slice(0, 10);
  if (st.day !== day) st = { day, count: 0 };
  if (st.count >= 3) return { allowed: false, rule: "daily_promotional_cap" };
  st.count++;
  await fs.writeFile(f, JSON.stringify(st));
  return { allowed: true, rule: "within_cap" };
}
