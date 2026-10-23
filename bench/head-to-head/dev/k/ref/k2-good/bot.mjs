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
import path from "node:path";
import os from "node:os";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sdir = () => process.env.STATE_DIR || path.join(os.tmpdir(), "bot-state-default");
async function locked(fn) {
  fs.mkdirSync(sdir(), { recursive: true });
  const lock = path.join(sdir(), ".lock");
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.rmdirSync(lock); } catch {}
      await sleep(2);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch {} }
}
function readState() { try { return JSON.parse(fs.readFileSync(path.join(sdir(), "state.json"), "utf8")); } catch { return {}; } }
function writeState(s) { const f = path.join(sdir(), "state.json"); const t = f + "." + process.pid + ".tmp"; fs.writeFileSync(t, JSON.stringify(s)); fs.renameSync(t, f); }
const LIMIT = 3;
function localDay(now, tz) { const p = parts(now, tz); return `${p.year}-${p.month}-${p.day}`; }
export async function reserve(user, messageId, now) {
  const day = localDay(now, user.timeZone);
  return locked(() => {
    const s = readState();
    const u = s[user.id];
    const rec = u && u.day === day ? u : { day, count: 0, ids: {} };
    if (rec.ids[messageId] !== undefined) return rec.ids[messageId];
    let res;
    if (rec.count >= LIMIT) res = { allowed: false, reason: `Daily limit of ${LIMIT} pushes reached for ${day}` };
    else { rec.count++; res = { allowed: true, reason: `Within the daily limit (${rec.count} of ${LIMIT})` }; }
    rec.ids[messageId] = res;
    s[user.id] = rec;
    writeState(s);
    return res;
  });
}
