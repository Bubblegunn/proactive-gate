// Runs one workerz.mjs process for a plan and resolves with its parsed RESULT array.
// runProc(botdir, stateDir, plan, conc): conc true runs the plan's calls concurrently inside that process.
// Rejects on timeout or when the process prints no result (stderr is included in the message).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const worker = join(dirname(fileURLToPath(import.meta.url)), "workerz.mjs");

export function runProc(botdir, stateDir, plan, conc = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, botdir, stateDir, JSON.stringify(plan)], {
      env: { ...process.env, STATE_DIR: stateDir, CONC: conc ? "1" : "0" },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("worker timeout"));
    }, 60000);
    child.on("close", () => {
      clearTimeout(timer);
      const m = out.match(/RESULT(.*)/);
      if (!m) return reject(new Error("no result: " + (err || out).slice(0, 300)));
      resolve(JSON.parse(m[1]));
    });
  });
}
