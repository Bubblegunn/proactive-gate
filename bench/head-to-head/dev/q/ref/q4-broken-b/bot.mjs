import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const dirOf = () => process.env.STATE_DIR || join(process.cwd(), ".state");
async function load() { try { return JSON.parse(await readFile(join(dirOf(), "optout.json"), "utf8")); } catch { return {}; } }
function norm(p) { let d = String(p).replace(/\D/g, ""); if (d.length === 11 && d[0] === "1") d = d.slice(1); return d; }
const STOP = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
export async function handleInbound({ from, body }) {
  const w = String(body ?? "").trim().toLowerCase();
  if (STOP.has(w)) { await mkdir(dirOf(), { recursive: true }); const s = await load(); s[norm(from)] = true; await writeFile(join(dirOf(), "optout.json"), JSON.stringify(s)); return { action: "opt_out", reason: "stop", reply: "You are unsubscribed." }; }
  if (w === "help") return { action: "help", reason: "help", reply: "Reply STOP to unsubscribe." };
  return { action: "none", reason: undefined, reply: null };
}
export async function canText(phone) { const s = await load(); return s[norm(phone)] ? { allowed: false, reason: "opted_out" } : { allowed: true, reason: "ok" }; }
