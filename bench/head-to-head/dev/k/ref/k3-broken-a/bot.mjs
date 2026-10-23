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
const STOP = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const START = new Set(["START", "UNSTOP", "YES"]);
export async function handleInbound({ userId, channel, text, receivedAt }) {
  const kw = String(text ?? "").trim().toUpperCase();
  if (kw === "HELP") return { reply: "Reply STOP to unsubscribe. Help: support@example.com" };
  const stop = STOP.has(kw), start = START.has(kw);
  if (!stop && !start) return { reply: null };
  await locked(() => { const s = readState(); s[userId] = { out: stop }; writeState(s); });
  return { reply: stop ? "You are unsubscribed. Reply START to resubscribe." : "You are subscribed again." };
}
export async function canSend(userId, channel, now) {
  return locked(() => { const c = readState()[userId]; return c && c.out ? { allowed: false, reason: "opted out" } : { allowed: true, reason: "ok" }; });
}
