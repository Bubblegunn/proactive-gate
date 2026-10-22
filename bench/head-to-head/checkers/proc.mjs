import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const worker = join(dirname(fileURLToPath(import.meta.url)), "worker.mjs");
export function run(dir, state, plan, conc = false) {
  return new Promise((res, rej) => {
    const c = spawn(process.execPath, [worker, dir, state, JSON.stringify(plan)], { env: { ...process.env, STATE_DIR: state, CONC: conc ? "1" : "0" } });
    let o = "", e = "";
    c.stdout.on("data", (d) => (o += d)); c.stderr.on("data", (d) => (e += d));
    const t = setTimeout(() => { c.kill(); rej(new Error("worker timeout")); }, 60000);
    c.on("close", () => { clearTimeout(t); const m = o.match(/RESULT(.*)/); if (!m) return rej(new Error("no result: " + (e || o).slice(0, 200))); res(JSON.parse(m[1])); });
  });
}
