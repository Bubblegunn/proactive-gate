// Trigger measurement: does the agent call the proactive-gate skill on a prompt, and does the
// UserPromptSubmit hook fire on it. Each `claude -p` run gets its own empty folder and a throw-away
// HOME, with the same isolation and guard as bench/head-to-head/run.mjs.
//
//   node measure.mjs --out DIR [--model claude-sonnet-5-5] [--parallel 4] [--timeout-min 5]
//   node measure.mjs --out DIR --hook-only
//
// --hook-only runs hooks/trigger.sh on every prompt and never starts claude.
// Writes DIR/trigger.json (or DIR/trigger-hook-only.json) and prints the counts.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const hook = join(repo, "hooks/trigger.sh");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
if (!opt("out", "")) throw new Error("--out DIR is required");
const out = resolve(opt("out", ""));
const model = opt("model", "claude-sonnet-5-5");
const parallel = Number(opt("parallel", "4"));
const timeoutMs = Number(opt("timeout-min", "5")) * 60_000;

const readList = (file) => readFileSync(join(here, file), "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
const natural = readList("natural.txt");
const unrelated = readList("unrelated.txt");

// ---- hook only: no claude, just trigger.sh --------------------------------------------------

const hookFires = (prompt) => {
  const run = spawnSync("sh", [hook], { input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt }), encoding: "utf8" });
  if (run.status !== 0) throw new Error(`trigger.sh exited ${run.status} on: ${prompt}\n${run.stderr}`);
  return run.stdout.trim().length > 0;
};

if (flag("hook-only")) {
  const naturalHits = natural.filter(hookFires).length;
  const unrelatedHits = unrelated.filter(hookFires).length;
  const result = {
    kind: "hook-only",
    natural: { fired: naturalHits, of: natural.length },
    unrelated: { fired: unrelatedHits, of: unrelated.length },
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "trigger-hook-only.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`hook fired on ${naturalHits} of ${natural.length} natural prompts`);
  console.log(`hook fired on ${unrelatedHits} of ${unrelated.length} unrelated prompts (false triggers)`);
  process.exit(0);
}

// ---- full run: one claude -p per prompt, the skill call read from the stream -----------------

const realHome = homedir();
// Same guard as run.mjs: the real hooks and mcpServers are hashed before and after every run.
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

const claudeBin = spawnSync("sh", ["-c", "command -v claude"], { encoding: "utf8" }).stdout.trim();
if (!claudeBin) throw new Error("claude is not on PATH");
const pathFor = () => [dirname(process.execPath), dirname(claudeBin), "/usr/bin", "/bin", "/usr/local/bin", "/opt/homebrew/bin"].join(":");

function fakeHome(name) {
  const home = join(out, "_home", name);
  mkdirSync(join(home, "Library"), { recursive: true });
  try { symlinkSync(join(realHome, "Library/Keychains"), join(home, "Library/Keychains")); } catch {}
  return home;
}

// The Skill tool_use blocks in a stream-json transcript, with their input.
function skillCalls(text) {
  const calls = [];
  for (const line of text.split("\n")) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    for (const block of event?.message?.content ?? []) {
      if (block?.type === "tool_use" && block.name === "Skill") calls.push(block.input);
    }
  }
  return calls;
}

function runOne(kind, index, prompt) {
  const name = `${kind}-${index + 1}`;
  assertUnchanged(`before ${name}`);
  const work = join(out, "work", name);
  mkdirSync(work, { recursive: true });
  mkdirSync(join(out, "_home"), { recursive: true });
  const settings = join(out, "_home", `${name}.settings.json`);
  writeFileSync(settings, JSON.stringify({ env: { PATH: pathFor() } }));
  mkdirSync(join(out, "runs"), { recursive: true });
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(claudeBin, ["-p", prompt, "--setting-sources", "project", "--settings", settings, "--plugin-dir", repo, "--model", model, "--max-turns", "3", "--dangerously-skip-permissions", "--strict-mcp-config", "--output-format", "stream-json", "--verbose"],
      { cwd: work, env: { ...process.env, HOME: fakeHome(name), PATH: pathFor() }, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (d) => (text += d));
    child.stderr.on("data", (d) => (text += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      assertUnchanged(`after ${name}`);
      writeFileSync(join(out, "runs", `${name}.jsonl`), text);
      const calls = skillCalls(text);
      const row = {
        kind,
        prompt,
        invoked: calls.some((input) => JSON.stringify(input).includes("proactive-gate")),
        skillInputs: calls,
        finished: /"type":"result"/.test(text),
        code,
        seconds: Math.round((Date.now() - started) / 1000),
      };
      writeFileSync(join(out, "runs", `${name}.meta.json`), JSON.stringify(row));
      console.log(JSON.stringify({ name, invoked: row.invoked, finished: row.finished }));
      done(row);
    });
  });
}

const jobs = [...natural.map((p, i) => ["natural", i, p]), ...unrelated.map((p, i) => ["unrelated", i, p])];
const results = [];
const queue = [...jobs];
await Promise.all(Array.from({ length: parallel }, async () => {
  for (let job = queue.shift(); job; job = queue.shift()) results.push(await runOne(...job));
}));

const of = (kind) => results.filter((r) => r.kind === kind);
const natRows = of("natural");
const unrelRows = of("unrelated");
const count = (rows) => rows.filter((r) => r.invoked).length;
const unfinished = results.filter((r) => !r.finished).length;
const result = {
  kind: "claude",
  model,
  natural: { invoked: count(natRows), of: natRows.length, rate: count(natRows) / natRows.length, prompts: natRows },
  unrelated: { falseTriggers: count(unrelRows), of: unrelRows.length, rate: count(unrelRows) / unrelRows.length, prompts: unrelRows },
  unfinished,
};
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "trigger.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(`natural: the skill was invoked on ${result.natural.invoked} of ${result.natural.of} prompts`);
console.log(`unrelated: the skill was invoked on ${result.unrelated.falseTriggers} of ${result.unrelated.of} prompts (false-trigger rate)`);
console.log(`runs that did not finish (no result event): ${unfinished}`);
if (unfinished > 0) console.log("a run that did not finish is not a zero: read its runs/*.jsonl before quoting the rate");
