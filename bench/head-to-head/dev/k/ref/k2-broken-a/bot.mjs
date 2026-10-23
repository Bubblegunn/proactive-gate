const fmts = new Map();
function parts(date, tz) {
  let f = fmts.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); fmts.set(tz, f); }
  const o = {}; for (const p of f.formatToParts(date)) o[p.type] = +p.value; return o;
}
function offsetMs(date, tz) { const p = parts(date, tz); return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000; }
function localToUtc(y, m, d, h, mi, tz) { const g = Date.UTC(y, m - 1, d, h, mi); let t = g - offsetMs(new Date(g), tz); t = g - offsetMs(new Date(t), tz); return new Date(t); }
function nextDay(p) { const n = new Date(Date.UTC(p.year, p.month - 1, p.day + 1)); return { year: n.getUTCFullYear(), month: n.getUTCMonth() + 1, day: n.getUTCDate() }; }
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
const sdir = () => process.env.STATE_DIR;
function localDay(now, tz) { const p = parts(now, tz); return `${p.year}-${p.month}-${p.day}`; }
export async function reserve(user, messageId, now) {
  fs.mkdirSync(sdir(), { recursive: true });
  const f = path.join(sdir(), "counts.json");
  const day = localDay(now, user.timeZone);
  let s = {};
  try { s = JSON.parse(await fsp.readFile(f, "utf8")); } catch {}
  const rec = s[user.id] && s[user.id].day === day ? s[user.id] : { day, count: 0 };
  if (rec.count >= 3) return { allowed: false, reason: "daily limit reached" };
  rec.count++;
  s[user.id] = rec;
  await fsp.writeFile(f, JSON.stringify(s));
  return { allowed: true, reason: "within limit" };
}
