import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
const db = () => path.join(process.env.STATE_DIR, "slots.json");
const load = async () => { try { return JSON.parse(await fs.readFile(db(), "utf8")); } catch { return []; } };
const save = async (x) => { await fs.mkdir(process.env.STATE_DIR, { recursive: true }); await fs.writeFile(db(), JSON.stringify(x)); };
export async function reserve(req, now) {
  const all = await load();
  const t = now.getTime();
  const mine = all.filter((s) => s.userId === req.userId);
  if (mine.filter((s) => s.t > t - req.windowHours * 3600000).length >= req.maxPerWindow) return { allowed: false, reason: "window_limit", reservationId: null };
  if (mine.some((s) => t - s.t < req.minGapMinutes * 60000 && s.t <= t)) return { allowed: false, reason: "min_gap", reservationId: null };
  const id = crypto.randomUUID();
  all.push({ id, userId: req.userId, t });
  await save(all);
  return { allowed: true, reason: null, reservationId: id };
}
export async function release(id) { await save((await load()).filter((s) => s.id !== id)); }
