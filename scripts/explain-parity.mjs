#!/usr/bin/env node
/**
 * "TypeScript and Python ship the same sentences" is a claim, and this is the run that
 * settles it. Every fixture under spec/fixtures is evaluated by both gates, every decision
 * is rendered by both explain() implementations, and the two renderings are compared
 * sentence by sentence. Two catalogs maintained by hand in two languages drift, and both
 * suites stay green while they do, because each asserts only its own wording.
 *
 *   node scripts/explain-parity.mjs
 *
 * The package has no runtime dependencies, so the source path on PYTHONPATH is enough and
 * nothing has to be installed. Node built-ins only. PYTHON overrides the interpreter.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixtures = join(root, "spec/fixtures");

function fail(message) {
  console.error(`explain-parity: ${message}`);
  process.exit(1);
}

function run(label, command, args, options = {}) {
  const shell = process.platform === "win32" && command === "npm";
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", shell, ...options });
  if (result.error) fail(`${label}: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} exited ${result.status}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  return (result.stdout ?? "").trim();
}

// Both scripts walk the fixtures in the same order, seed the same store, evaluate the same
// inputs and commit where the fixture commits, so any difference in the output is a
// difference in the sentences.
const tsScript = `
import { loadFixtures } from "${new URL("../dist/src/conformance.js", import.meta.url).href}";
import { createGate } from "${new URL("../dist/src/gate.js", import.meta.url).href}";
import { MemoryStore } from "${new URL("../dist/src/stores.js", import.meta.url).href}";
import { explain } from "${new URL("../dist/src/explain.js", import.meta.url).href}";

const out = [];
for (const fixture of await loadFixtures(process.env.FIXTURES)) {
  const store = new MemoryStore();
  const prefix = fixture.policy.keyPrefix ?? "pg:";
  for (const [key, value] of Object.entries(fixture.store_seed ?? {})) await store.set(prefix + key, value);
  let gate;
  try { gate = createGate({ policy: fixture.policy, store }); } catch { continue; } // a fixture whose policy must not compile
  for (const [i, t] of fixture.tests.entries()) {
    const input = { user: t.input.user, candidate: t.input.candidate, now: new Date(t.input.now) };
    const decision = await gate.evaluate(input);
    const e = explain(decision);
    out.push([fixture.name, i, e.summary, ...e.checks.map((c) => \`\${c.id}/\${c.outcome}\${c.shadow ? "/shadow" : ""}: \${c.sentence}\`)]);
    if (t.commit) await gate.commit(decision, input);
  }
}
console.log(JSON.stringify(out));
`;

const pyScript = `
import json, os
from proactive_gate.conformance import load_fixtures
from proactive_gate.explain import explain
from proactive_gate.gate import Gate
from proactive_gate.stores import MemoryStore
from proactive_gate.types import Candidate, EvaluateInput, UserState, to_datetime

out = []
for fixture in load_fixtures(os.environ["FIXTURES"]):
    store = MemoryStore()
    prefix = fixture["policy"].get("keyPrefix", "pg:")
    for key, value in (fixture.get("store_seed") or {}).items():
        store.set(prefix + key, value)
    try:
        gate = Gate.from_policy(fixture["policy"], store)
    except ValueError:  # a fixture whose policy must not compile
        continue
    for i, test in enumerate(fixture["tests"]):
        raw = test["input"]
        inp = EvaluateInput(UserState.from_dict(raw["user"]), Candidate.from_dict(raw["candidate"]), to_datetime(raw["now"]))
        decision = gate.evaluate(inp)
        e = explain(decision)
        row = [fixture["name"], i, e.summary]
        row += [f"{c.id}/{c.outcome}{'/shadow' if c.shadow else ''}: {c.sentence}" for c in e.checks]
        out.append(row)
        if test.get("commit"):
            gate.commit(decision, inp)
print(json.dumps(out))
`;

run("npm run build", "npm", ["run", "build"], { stdio: "ignore" });
const ts = JSON.parse(run("typescript", process.execPath, ["--input-type=module", "-e", tsScript], { env: { ...process.env, FIXTURES: fixtures } }));
const python = JSON.parse(
  run("python", process.env.PYTHON ?? "python3", ["-c", pyScript], { env: { ...process.env, PYTHONPATH: join(root, "python/src"), FIXTURES: fixtures } }),
);

if (!ts.length) fail("no decisions were rendered; the fixtures or the runner are wrong");
if (ts.length !== python.length) fail(`TypeScript rendered ${ts.length} decisions and Python ${python.length}`);

const differences = [];
for (const [i, row] of ts.entries()) {
  const other = python[i];
  const lines = Math.max(row.length, other.length);
  for (let line = 2; line < lines; line++) {
    if (row[line] !== other[line]) differences.push(`${row[0]} [${row[1]}]\n    ts: ${row[line] ?? "(nothing)"}\n    py: ${other[line] ?? "(nothing)"}`);
  }
  if (row[0] !== other[0] || row[1] !== other[1]) differences.push(`fixture order differs at ${i}: ${row[0]} [${row[1]}] against ${other[0]} [${other[1]}]`);
}
if (differences.length) {
  for (const d of differences) console.error(`  ${d}`);
  fail(`${differences.length} sentence(s) differ between the implementations`);
}

const sentences = ts.reduce((n, row) => n + row.length - 2, 0);
console.log(`explain-parity: ok, ${sentences} sentences identical across ${ts.length} decisions in ${new Set(ts.map((r) => r[0])).size} fixtures`);
