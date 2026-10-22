// Head-to-head runner. Spawns one headless `claude -p` per arm, task and repetition in a fresh folder.
//
//   node run.mjs --out DIR [--arms ours,baseline,knock,knock-inv] [--tasks z1,z2,z3,z4,z5,z6] [--reps 3]
//                [--parallel 4] [--model sonnet] [--timeout-min 15]
//
// Environment (absolute paths):
//   H2H_NODE_BIN     folder holding node, npm and npx of Node 22 or newer; put first on PATH for EVERY arm
//   H2H_OURS_DIR     plugin directory of the build under test: an immutable archive of the commit (required for "ours")
//   H2H_TARBALL      `npm pack` output of the same archive (the "ours" fixture depends on it, not installed yet)
//   H2H_KNOCK_DIR    Knock skills plugin directory
// Vaara is not run: its first-run setup rewrote the global Claude Code configuration twice, even with a throw-away HOME.
// The plugin directory for "ours" is H2H_OURS_DIR, never the working tree; "baseline" is arms/baseline (an empty plugin).
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, cpSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const out = resolve(args.out ?? "");
if (!args.out) throw new Error("--out DIR is required");
const arms = (args.arms ?? "ours,baseline,knock,knock-inv").split(",");
const tasks = (args.tasks ?? "z1,z2,z3,z4,z5,z6").split(",");
const reps = Number(args.reps ?? 3);
const parallel = Number(args.parallel ?? 4);
const model = args.model ?? "sonnet";
const timeoutMs = Number(args["timeout-min"] ?? 15) * 60_000;
const need = (name) => { const v = process.env[name]; if (!v) throw new Error(`${name} is not set`); return v; };
const nodeBin = need("H2H_NODE_BIN");
if (arms.includes("ours")) need("H2H_OURS_DIR"); // fail before any job starts, not in the middle of the queue

const pluginDir = {
  ours: () => need("H2H_OURS_DIR"),
  baseline: join(here, "arms/baseline"),
  knock: () => need("H2H_KNOCK_DIR"),
  "knock-inv": () => need("H2H_KNOCK_DIR"),
  courier: () => need("H2H_COURIER_DIR"),
  "courier-inv": () => need("H2H_COURIER_DIR"),
};
// The "invoked" arms start the prompt with a sentence that names the competitor's skill or plugin the way its README
// does, so each competitor is also measured at its best. Every other arm gets the task text alone.
const invocation = {
  "knock-inv": "Use the knock-notification-best-practices skill from the Knock skills plugin for this. ",
  "courier-inv": "Use the courier skill from the Courier skills plugin for this. ",
};
const dirFor = (arm) => (typeof pluginDir[arm] === "function" ? pluginDir[arm]() : pluginDir[arm]);

// Every arm runs with HOME set to a throw-away folder, so no competitor installer or first-run setup can touch the real configuration, and every arm sees the same
// empty user-level configuration. Only the keychain folder is linked, read-only in practice, so `claude -p` stays logged in.
// Hooks reach claude only through the plugin directory under test and the --settings file written below.
const realHome = homedir();
const guardFiles = () => {
  const read = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
  const hash = (o) => createHash("sha256").update(JSON.stringify(o ?? null)).digest("hex");
  return { hooks: hash(read(join(realHome, ".claude/settings.json"))?.hooks), mcpServers: hash(read(join(realHome, ".claude.json"))?.mcpServers) };
};
const baseline = guardFiles();
function assertUnchanged(where) {
  const now = guardFiles();
  if (now.hooks !== baseline.hooks || now.mcpServers !== baseline.mcpServers) {
    console.error(`STOP: the real hooks or mcpServers changed ${where}. before=${JSON.stringify(baseline)} now=${JSON.stringify(now)}`);
    process.exit(3);
  }
}
function fakeHome(name) {
  const home = join(out, "_home", name);
  mkdirSync(join(home, "Library"), { recursive: true });
  try { symlinkSync(join(realHome, "Library/Keychains"), join(home, "Library/Keychains")); } catch {}
  return home;
}

function pathFor(arm) {
  // Homebrew comes before /usr/bin so that python3 is 3.11 or newer for every arm (/usr/bin/python3 is 3.9).
  return [nodeBin, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":");
}

function prepare(job) {
  mkdirSync(join(out, "_home"), { recursive: true });
  const work = join(out, "work", job.name);
  mkdirSync(join(work, ".claude"), { recursive: true });
  const pkg = { name: "fixture", private: true, type: "module", version: "0.0.0" };
  if (job.arm === "ours") pkg.dependencies = { "proactive-gate": `file:${resolve(need("H2H_TARBALL"))}` };
  writeFileSync(join(work, "package.json"), JSON.stringify(pkg));
  writeFileSync(join(work, ".claude/settings.json"), JSON.stringify({ env: { PATH: pathFor(job.arm) } }));
  writeFileSync(join(out, "_home", `${job.name}.settings.json`), JSON.stringify({ env: { PATH: pathFor(job.arm) } }));
  const fixture = join(here, "fixtures", job.task);
  if (existsSync(fixture)) cpSync(fixture, work, { recursive: true });
  return work;
}

// Only what `claude -p` needs. The parent shell may carry CLAUDE_* and MAX_THINKING_TOKENS settings of a host app that a
// model rejects or that change thinking and effort; every arm must see the same environment.
function cleanEnv(home, arm) {
  const keep = ["ANTHROPIC_API_KEY", "LANG", "LC_ALL", "TERM", "TMPDIR", "SHELL", "USER", "LOGNAME"];
  return { ...Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]])), HOME: home, PATH: pathFor(arm) };
}

function runJob(job) {
  assertUnchanged(`before ${job.name}`);
  const work = prepare(job);
  const prompt = (invocation[job.arm] ?? "") + readFileSync(join(here, "prompts", `${job.task}.txt`), "utf8").trim();
  mkdirSync(join(out, "runs"), { recursive: true });
  const log = join(out, "runs", `${job.name}.jsonl`);
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn("claude", ["-p", prompt, "--setting-sources", "project", "--settings", join(out, "_home", `${job.name}.settings.json`), "--plugin-dir", dirFor(job.arm), "--model", model, "--dangerously-skip-permissions", "--strict-mcp-config", "--output-format", "stream-json", "--verbose"],
      { cwd: work, env: cleanEnv(fakeHome(job.name), job.arm), stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (d) => (text += d));
    child.stderr.on("data", (d) => (text += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      assertUnchanged(`after ${job.name}`);
      writeFileSync(log, text);
      if (/You've hit your limit|"is_error":true,"duration_ms":\d+,"duration_api_ms":0/.test(text)) {
        console.error(`STOP: ${job.name} failed because of an account limit or API error, not because of the task. Nothing else is run; delete runs/${job.name}.jsonl and run again.`);
        process.exit(4);
      }
      const cost = [...text.matchAll(/"total_cost_usd":([0-9.eE-]+)/g)].pop()?.[1];
      const turns = [...text.matchAll(/"num_turns":(\d+)/g)].pop()?.[1];
      const meta = { ...job, model, work, code, seconds: Math.round((Date.now() - started) / 1000), costUsd: cost ? Number(cost) : null, turns: turns ? Number(turns) : null,
        skillCalls: (text.match(/"name":"Skill"/g) ?? []).length };
      writeFileSync(join(out, "runs", `${job.name}.meta.json`), JSON.stringify(meta));
      console.log(JSON.stringify(meta));
      done(meta);
    });
  });
}

const jobs = [];
for (const rep of Array.from({ length: reps }, (_, i) => i + 1)) for (const task of tasks) for (const arm of arms) jobs.push({ arm, task, rep, name: `${arm}-${task}-${rep}` });
const skip = (j) => existsSync(join(out, "runs", `${j.name}.meta.json`));
const queue = jobs.filter((j) => !skip(j));
await Promise.all(Array.from({ length: parallel }, async () => { for (let j = queue.shift(); j; j = queue.shift()) await runJob(j); }));
console.log("all runs finished", jobs.length);
