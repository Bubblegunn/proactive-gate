// usage: node score.mjs --out DIR [--labels labels.json]
// Run AFTER run.mjs. Checkers run one at a time because h2, h4, x1 and x2 spawn many processes.
// Writes results.json, table-full.md and table-outcome.md. The outcome table counts only criteria labelled "outcome"
// in labels.json (what the user receives); criteria labelled "process" are reported in the full table only.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv;
const flag = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const out = resolve(flag("--out", ""));
const tasksRoot = process.env.H2H_TASKS_DIR || here; // Round 5: held-out task sets live outside this folder
const labelsPath = resolve(flag("--labels", join(tasksRoot, "labels.json")));
const nodeBin = process.env.H2H_NODE_BIN;
if (!nodeBin) throw new Error("H2H_NODE_BIN is not set");
const labels = existsSync(labelsPath) ? JSON.parse(readFileSync(labelsPath, "utf8")) : {};
const metas = readdirSync(join(out, "runs")).filter((f) => f.endsWith(".meta.json")).map((f) => JSON.parse(readFileSync(join(out, "runs", f), "utf8")));
metas.sort((a, b) => a.name.localeCompare(b.name));

// Lines of code the agent wrote: non-blank lines in the files left in its folder, not counting package files,
// node_modules, hidden folders and files that came with the task fixture. "loc" counts source files only;
// "locAll" also counts other JSON the agent or its tools produced (for example a generated policy file).
function countLines(dir, fixtureNames) {
  let loc = 0, locAll = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (/^package(-lock)?\.json$|^go\.sum$/.test(name) || fixtureNames.has(name)) continue;
      const n = readFileSync(p, "utf8").split("\n").filter((l) => l.trim() !== "").length;
      if (/\.(mjs|cjs|js|ts|py|go|sh)$/.test(name) || name === "go.mod") loc += n;
      if (/\.(mjs|cjs|js|ts|py|go|sh|json|jsonl|md|txt)$/.test(name) || name === "go.mod") locAll += n;
    }
  };
  try { walk(dir); } catch {}
  return { loc, locAll };
}
const rows = [];
for (const m of metas) {
  const bot = join(m.work, "bot.mjs");
  let criteria = {};
  let detail = "no bot.mjs";
  {
    const r = spawnSync(join(nodeBin, "node"), [join(tasksRoot, "checkers", `${m.task}.mjs`), m.work], { encoding: "utf8", timeout: 240_000, env: { ...process.env, PATH: `${nodeBin}:${process.env.PATH}` } });
    const text = (r.stdout ?? "") + (r.stderr ?? "");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    try { criteria = JSON.parse(text.slice(start, end + 1)); detail = "ok"; } catch { detail = `checker produced no result: ${text.slice(0, 400)}`; }
  }
  const entries = Object.entries(criteria).map(([name, v]) => ({ n: name.split(" ")[0], name, pass: v === "PASS", why: v === "PASS" ? "" : String(v) }));
  const label = (e) => labels[m.task]?.[e.n]?.label ?? "outcome";
  const full = entries.filter((e) => e.pass).length;
  const outcome = entries.filter((e) => e.pass && label(e) === "outcome").length;
  const outcomeMax = entries.filter((e) => label(e) === "outcome").length || (labels[m.task] ? Object.values(labels[m.task]).filter((l) => l.label === "outcome").length : 6);
  const fixtureDir = join(tasksRoot, "fixtures", m.task);
  const lines = countLines(m.work, new Set(existsSync(fixtureDir) ? readdirSync(fixtureDir) : []));
  let source = "";
  try { for (const f of readdirSync(m.work)) if (/\.(mjs|js|ts|py|go)$|^go\.mod$|^requirements/.test(f)) source += readFileSync(join(m.work, f), "utf8"); } catch {}
  rows.push({ ...m, ...lines, full, outcome, outcomeMax, criteria: entries, usesLibrary: /proactive-gate/.test(source), detail });
  console.log(m.name, full, outcome, m.costUsd);
}
writeFileSync(join(out, "results.json"), JSON.stringify(rows, null, 1));

const arms = [...new Set(rows.map((r) => r.arm))];
const tasks = [...new Set(rows.map((r) => r.task))].sort();
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const cell = (arm, task, field) => {
  const rs = rows.filter((r) => r.arm === arm && r.task === task);
  if (!rs.length) return "n/a";
  const v = rs.map((r) => r[field]);
  return `${mean(v).toFixed(2)} [${v.join(", ")}] (${Math.min(...v)}-${Math.max(...v)}, n=${v.length})`;
};
function table(field, title, maxOf) {
  const lines = [`### ${title}`, "", "Each cell: mean [score of each run] (min-max, n runs).", "", "| task (max) | " + arms.join(" | ") + " |", "|---|" + arms.map(() => "---").join("|") + "|"];
  for (const t of tasks) lines.push(`| ${t} (${maxOf(t)}) | ` + arms.map((a) => cell(a, t, field)).join(" | ") + " |");
  const total = (a) => tasks.reduce((s, t) => s + mean(rows.filter((r) => r.arm === a && r.task === t).map((r) => r[field])), 0);
  lines.push(`| total of means (${tasks.reduce((s, t) => s + maxOf(t), 0)}) | ` + arms.map((a) => total(a).toFixed(2)).join(" | ") + " |");
  return lines;
}
const maxFull = () => 6;
const maxOutcome = (t) => rows.find((r) => r.task === t)?.outcomeMax ?? 6;
// Mean cost of an arm divided by the mean cost of the baseline arm (ratio, 2 decimals); n/a when either is missing.
const costOf = (a) => mean(rows.filter((r) => r.arm === a && r.costUsd !== null).map((r) => r.costUsd));
const costRatio = (a) => {
  const base = costOf("baseline");
  const own = costOf(a);
  return Number.isFinite(base) && base > 0 && Number.isFinite(own) ? (own / base).toFixed(2) : "n/a";
};
// The commit the runs were made from, written by rerun.sh; the first line of both tables names it.
const commitFile = join(out, "COMMIT");
const commitLine = `Commit under test: ${existsSync(commitFile) ? readFileSync(commitFile, "utf8").trim() : "unknown (no COMMIT file in this folder)"}`;
const extra = ["", "| measure | " + arms.join(" | ") + " |", "|---|" + arms.map(() => "---").join("|") + "|",
  "| mean cost USD per run | " + arms.map((a) => mean(rows.filter((r) => r.arm === a && r.costUsd !== null).map((r) => r.costUsd)).toFixed(3)).join(" | ") + " |",
  "| cost vs baseline | " + arms.map((a) => costRatio(a)).join(" | ") + " |",
  "| mean wall time per run, seconds | " + arms.map((a) => mean(rows.filter((r) => r.arm === a).map((r) => r.seconds)).toFixed(0)).join(" | ") + " |",
  "| mean turns per run | " + arms.map((a) => mean(rows.filter((r) => r.arm === a && r.turns !== null).map((r) => r.turns)).toFixed(1)).join(" | ") + " |",
  "| mean lines of code written (source files) | " + arms.map((a) => mean(rows.filter((r) => r.arm === a).map((r) => r.loc)).toFixed(0)).join(" | ") + " |",
  "| mean lines written (all text files) | " + arms.map((a) => mean(rows.filter((r) => r.arm === a).map((r) => r.locAll)).toFixed(0)).join(" | ") + " |",
  "| runs whose solution mentions proactive-gate | " + arms.map((a) => `${rows.filter((r) => r.arm === a && r.usesLibrary).length}/${rows.filter((r) => r.arm === a).length}`).join(" | ") + " |",
  "| Skill tool calls (sum) | " + arms.map((a) => rows.filter((r) => r.arm === a).reduce((s, r) => s + r.skillCalls, 0)).join(" | ") + " |"];
writeFileSync(join(out, "table-full.md"), [commitLine, "", ...table("full", "All criteria", maxFull), ...extra].join("\n") + "\n");
writeFileSync(join(out, "table-outcome.md"), [commitLine, "", ...table("outcome", "Outcome criteria only (labels.json)", maxOutcome), ...extra].join("\n") + "\n");
console.log(readFileSync(join(out, "table-outcome.md"), "utf8"));
