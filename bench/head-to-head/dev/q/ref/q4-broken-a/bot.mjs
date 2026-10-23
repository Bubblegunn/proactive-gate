import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
const dirOf = () => process.env.STATE_DIR || join(process.cwd(), ".state");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withLock(fn) {
  const d = dirOf(); await mkdir(d, { recursive: true }); const lock = join(d, "lock"); const t0 = Date.now();
  for (;;) { try { await mkdir(lock); break; } catch (e) { if (e.code !== "EEXIST") throw e; if (Date.now() - t0 > 10000) await rm(lock, { recursive: true, force: true }); await sleep(2 + Math.random() * 5); } }
  try { return await fn(join(d, "optout.json")); } finally { await rm(lock, { recursive: true, force: true }); }
}
async function load(f) { try { return JSON.parse(await readFile(f, "utf8")); } catch { return {}; } }
async function save(f, s) { const t = f + "." + process.pid + ".tmp"; await writeFile(t, JSON.stringify(s)); await rename(t, f); }
function norm(p) { return String(p); }
const STOP = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const START = new Set(["start", "unstop", "yes"]);
export async function handleInbound({ from, body }) {
  const w = String(body ?? "").trim().toLowerCase();
  const n = norm(from);
  if ([...STOP].some((k) => w.includes(k))) { await withLock(async (f) => { const s = await load(f); s[n] = true; await save(f, s); }); return { action: "opt_out", reason: "stop_keyword", reply: "You are unsubscribed and will receive no more messages. Reply START to rejoin." }; }
  if (START.has(w)) { await withLock(async (f) => { const s = await load(f); delete s[n]; await save(f, s); }); return { action: "opt_in", reason: "start_keyword", reply: "You are subscribed again. Reply STOP to unsubscribe, HELP for help." }; }
  if (w === "help") return { action: "help", reason: "help_keyword", reply: "Salon texts. Msg&data rates may apply. Reply STOP to unsubscribe." };
  return { action: "none", reason: undefined, reply: null };
}
export async function canText(phone) {
  const s = await withLock(async (f) => load(f));
  return s[norm(phone)] ? { allowed: false, reason: "opted_out" } : { allowed: true, reason: "ok" };
}
