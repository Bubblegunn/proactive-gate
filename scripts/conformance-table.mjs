#!/usr/bin/env node
/**
 * Runs every fixture under spec/fixtures through both implementations and writes the
 * results table into README.md between the conformance markers. The table is generated
 * so it cannot drift from what the fixtures actually do; typing it by hand would make it
 * a claim rather than a measurement.
 *
 *   node scripts/conformance-table.mjs            regenerate the table
 *   node scripts/conformance-table.mjs --check    fail when the committed table is stale
 *
 * A failing fixture exits non-zero rather than producing a row that says "failed": this is
 * a gate, not a dashboard. The table carries no runtime version, because that differs per
 * machine and would leave the committed table permanently stale.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const check = process.argv.includes("--check");
const START = "<!-- conformance:start -->";
const END = "<!-- conformance:end -->";

const read = (p) => readFileSync(join(root, p), "utf8");
const specVersion = read("spec/SPEC_VERSION").trim();

/** Every fixture file, so the table's denominator comes from the directory, not from a runner. */
function fixtureNames() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".json")) out.push(JSON.parse(readFileSync(path, "utf8")).name);
    }
  };
  walk(join(root, "spec/fixtures"));
  return out;
}

/** Skips declared by an implementation, as a map of fixture name to the stated reason. */
function skips(impl) {
  let text = "";
  try {
    text = read(`spec/skip/${impl}.txt`);
  } catch {
    return new Map();
  }
  const out = new Map();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [name, ...reason] = trimmed.split("#");
    out.set(name.trim(), reason.join("#").trim());
  }
  return out;
}

function run(label, command, args, options = {}) {
  // npm is npm.cmd on Windows and spawnSync will not find it without a shell, the same
  // trap scripts/release.mjs hit.
  const shell = process.platform === "win32" && command === "npm";
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", shell, ...options });
  if (result.error) fail(`${label}: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} exited ${result.status}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  return (result.stdout ?? "").trim();
}

function fail(message) {
  console.error(`conformance-table: ${message}`);
  process.exit(1);
}

// TypeScript, through the same runner the test suite uses.
const tsScript = `
import { loadFixtures, readSkips, runFixture } from "${new URL("../dist/src/conformance.js", import.meta.url).href}";
const fixtures = await loadFixtures(process.env.FIXTURES);
const skipped = await readSkips(process.env.SKIPS);
const failures = [];
for (const fixture of fixtures) {
  if (skipped.has(fixture.name)) continue;
  const problems = await runFixture(fixture);
  if (problems.length) failures.push(...problems);
}
console.log(JSON.stringify({ ran: fixtures.length - skipped.size, failures }));
`;

// Python, through its own runner. The package has no runtime dependencies, so the source
// path on PYTHONPATH is enough and nothing has to be installed to check the claim.
const pyScript = `
import json, os
from proactive_gate.conformance import load_fixtures, read_skips, run_fixture
fixtures = list(load_fixtures(os.environ["FIXTURES"]))
skipped = read_skips(os.environ["SKIPS"])
failures = []
ran = 0
for fixture in fixtures:
    if fixture["name"] in skipped:
        continue
    ran += 1
    failures.extend(run_fixture(fixture))
print(json.dumps({"ran": ran, "failures": failures}))
`;

const names = fixtureNames();
const results = [];

{
  run("npm run build", "npm", ["run", "build"], { stdio: "ignore" });
  const out = run("typescript", process.execPath, ["--input-type=module", "-e", tsScript], {
    env: { ...process.env, FIXTURES: join(root, "spec/fixtures"), SKIPS: join(root, "spec/skip/ts.txt") },
  });
  results.push({ impl: "TypeScript", skips: skips("ts"), ...JSON.parse(out) });
}

{
  const python = process.env.PYTHON ?? "python3";
  const out = run("python", python, ["-c", pyScript], {
    env: {
      ...process.env,
      PYTHONPATH: join(root, "python/src"),
      FIXTURES: join(root, "spec/fixtures"),
      SKIPS: join(root, "spec/skip/python.txt"),
    },
  });
  results.push({ impl: "Python", skips: skips("python"), ...JSON.parse(out) });
}

const broken = results.filter((r) => r.failures.length);
if (broken.length) {
  for (const r of broken) console.error(`${r.impl}:\n  ${r.failures.join("\n  ")}`);
  fail(`${broken.length} implementation(s) do not conform`);
}

const rows = results.map((r) => {
  const declared = r.skips.size === 0 ? "none" : [...r.skips].map(([name, why]) => `${name} (${why || "no reason given"})`).join("; ");
  return `| ${r.impl} | ${specVersion} | ${r.ran} of ${names.length} | ${declared} |`;
});

const table = [
  `Generated by \`npm run conformance-table\`; CI fails when it is stale.`,
  "",
  "| implementation | spec version | fixtures passed | declared skips |",
  "|---|---|---:|---|",
  ...rows,
].join("\n");

const readme = read("README.md");
const start = readme.indexOf(START);
const end = readme.indexOf(END);
if (start === -1 || end === -1) fail(`README.md is missing the ${START} / ${END} markers`);
const next = `${readme.slice(0, start + START.length)}\n${table}\n${readme.slice(end)}`;

if (check) {
  if (next !== readme) fail("README.md conformance table is stale; run `npm run conformance-table`");
  console.log(`conformance table current: ${results.map((r) => `${r.impl} ${r.ran}/${names.length}`).join(", ")}`);
} else {
  writeFileSync(join(root, "README.md"), next);
  console.log(`wrote the conformance table: ${results.map((r) => `${r.impl} ${r.ran}/${names.length}`).join(", ")}`);
}
