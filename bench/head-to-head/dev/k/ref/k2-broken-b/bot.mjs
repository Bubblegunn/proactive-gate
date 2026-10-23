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
const DAY = 24 * 3600 * 1000;
export async function reserve(user, messageId, now) {
  const t = now.getTime();
  return locked(() => {
    const s = readState();
    const rec = s[user.id] || { sent: [], ids: {} };
    if (rec.ids[messageId] !== undefined) return rec.ids[messageId];
    rec.sent = rec.sent.filter((x) => x > t - DAY);
    let res;
    if (rec.sent.length >= 3) res = { allowed: false, reason: "3 pushes in the last 24 hours" };
    else { rec.sent.push(t); res = { allowed: true, reason: "within limit" }; }
    rec.ids[messageId] = res;
    s[user.id] = rec;
    writeState(s);
    return res;
  });
}
