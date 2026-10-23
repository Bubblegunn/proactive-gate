import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
export async function load(dir) {
  // a fresh module instance per call: never share state between criteria
  return import(pathToFileURL(join(dir, "bot.mjs")).href + "?v=" + randomUUID());
}
export const D = (s) => new Date(s);
export function sameInstant(a, iso) {
  return typeof a === "string" && Date.parse(a) === Date.parse(iso);
}
export class Report {
  constructor() { this.r = {}; }
  async crit(name, fn) {
    try { const msgs = []; const ok = await fn((m) => msgs.push(m)); this.r[name] = ok ? "PASS" : "FAIL " + msgs.join("; "); }
    catch (e) { this.r[name] = "FAIL threw " + String(e && e.message || e).slice(0, 150); }
  }
  print() {
    const vals = Object.values(this.r);
    console.log(JSON.stringify(this.r, null, 1));
    console.log("SCORE", vals.filter((v) => v === "PASS").length + "/" + vals.length);
  }
}
