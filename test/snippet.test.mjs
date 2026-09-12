/**
 * The snippets the playground hands out, executed against the built package.
 *
 * A copyable snippet that does not run is worse than no snippet, because the reader blames
 * their own program for it. So these tests do not inspect the strings for plausibility: they
 * write the files the page offers, run them with node, and check that what came out matches
 * what the library itself decides for the same policy and input.
 *
 * The snippet imports "proactive-gate" by name, the way a reader's program would, and resolves
 * it through this package's own exports map. It is written into dist/, which is gitignored and
 * inside the package, so the bare import resolves exactly as it would for an installed copy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGate, MemoryStore, explain } from "proactive-gate";
import {
  EVENTS_FILE,
  POLICY_FILE,
  exportBundle,
  eventsFileText,
  installCommand,
  policyFileText,
  replayCommand,
  wireUpSnippet,
} from "../docs/site/public/playground/export.mjs";
import { inputFor, policyFor, scenarios } from "../docs/site/public/playground/scenarios.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "dist", "src", "cli.js");

/** A scratch directory inside the package, so a bare "proactive-gate" import resolves. */
function scratch() {
  const base = join(root, "dist", "snippet-smoke");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, "run-"));
}

const runNode = (dir, file) => spawnSync(process.execPath, [file], { cwd: dir, encoding: "utf8" });

test("the install command names the package and nothing else", () => {
  assert.equal(installCommand, "npm install proactive-gate");
});

test("the wire-up snippet runs, and says what the library says", async () => {
  // Two scenarios with opposite verdicts, so a snippet that always printed one of them fails.
  for (const key of ["ok", "quiet"]) {
    const scenario = scenarios.find((s) => s.key === key);
    const policy = policyFor(scenario);
    const input = inputFor(scenario);
    const dir = scratch();
    try {
      writeFileSync(join(dir, POLICY_FILE), policyFileText(policy));
      writeFileSync(join(dir, "run.mjs"), wireUpSnippet(input));

      const result = runNode(dir, "run.mjs");
      assert.equal(result.status, 0, `${key} exited ${result.status}: ${result.stderr}`);

      // What the library decides for the same policy and input, computed here rather than
      // assumed, so the snippet is checked against behaviour and not against a literal.
      const gate = createGate({ policy, store: new MemoryStore() });
      const direct = { user: input.user, candidate: input.candidate, now: new Date(input.now) };
      const decision = await gate.evaluate(direct);
      const expected = decision.allowed && (await gate.commit(decision, direct))
        ? `send ${decision.surfaces.join(",")}`
        : `stopped ${explain(decision).sentence}`;

      assert.equal(result.stdout.trim(), expected, `${key}: the snippet agrees with the library`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("the snippet's allowed and stopped branches are both reachable", async () => {
  const outputs = [];
  for (const key of ["ok", "quiet"]) {
    const scenario = scenarios.find((s) => s.key === key);
    const dir = scratch();
    try {
      writeFileSync(join(dir, POLICY_FILE), policyFileText(policyFor(scenario)));
      writeFileSync(join(dir, "run.mjs"), wireUpSnippet(inputFor(scenario)));
      outputs.push(runNode(dir, "run.mjs").stdout.trim());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  assert.ok(outputs.some((o) => o.startsWith("send ")), `one run sends: ${outputs.join(" | ")}`);
  assert.ok(outputs.some((o) => o.startsWith("stopped ")), `one run is stopped: ${outputs.join(" | ")}`);
  // The stopped branch carries the plain sentence, not the engineer-facing reason.
  const stopped = outputs.find((o) => o.startsWith("stopped "));
  assert.match(stopped, /quiet hours/i);
  assert.ok(!/priority normal is below the floor/.test(stopped), "the plain sentence, not the raw reason");
});

test("the replay command the page prints is the command that works", () => {
  // The page prints an npx invocation. npx would fetch from the registry, so what runs here is
  // the same subcommand and flags against the CLI this repository just built. That the printed
  // command resolves through npx to this same CLI is NOT verified by this test.
  assert.match(replayCommand, /^npx proactive-gate replay /);
  assert.ok(replayCommand.includes(`--policy ${POLICY_FILE}`));
  assert.ok(replayCommand.includes("--commit"));
  assert.ok(replayCommand.includes(EVENTS_FILE));

  const scenario = scenarios.find((s) => s.key === "ok");
  const dir = scratch();
  try {
    writeFileSync(join(dir, POLICY_FILE), policyFileText(policyFor(scenario)));
    writeFileSync(join(dir, EVENTS_FILE), eventsFileText(inputFor(scenario)));

    const flags = replayCommand.split(" ").slice(3); // drop "npx proactive-gate replay"
    const result = spawnSync(process.execPath, [cli, "replay", ...flags], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 candidates/);
    assert.match(result.stdout, /1 allowed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the events file carries only fields the library reads", () => {
  // deliveredToday is the playground's own key for spending the budget first. Writing it into a
  // file that looks like a library input would hand over a field that silently does nothing.
  const budget = scenarios.find((s) => s.key === "budget");
  const input = inputFor(budget);
  assert.equal(input.deliveredToday, 3, "the scenario really carries it");

  const line = JSON.parse(eventsFileText(input));
  assert.deepEqual(Object.keys(line).sort(), ["candidate", "now", "user"]);
  assert.equal(line.deliveredToday, undefined);
});

test("the policy file is the policy, and the CLI accepts it", () => {
  for (const scenario of scenarios) {
    const text = policyFileText(policyFor(scenario));
    const parsed = JSON.parse(text);
    assert.equal(parsed.specVersion, policyFor(scenario).specVersion);
    assert.ok(Array.isArray(parsed.checks) && parsed.checks.length > 0);
    assert.match(text, /\n$/, "a file ends with a newline");
  }
});

test("nothing on offer puts the run in a URL", () => {
  // The privacy line this slice holds: no share link until a versioned-config design exists.
  const scenario = scenarios.find((s) => s.key === "ok");
  const bundle = exportBundle(policyFor(scenario), inputFor(scenario));
  const everything = [bundle.install, bundle.replay, bundle.policyFile.text, bundle.eventsFile.text, bundle.snippet.text].join("\n");

  assert.ok(!/location\.hash|URLSearchParams|replaceState|pushState/.test(everything));
  assert.ok(!/https?:\/\/[^\s"]*[?#]/.test(everything), "no URL carrying a query string or fragment");

  // And the page itself does not write one.
  const page = fileURLToPath(new URL("../docs/site/src/pages/playground.astro", import.meta.url));
  const source = readFileSync(page, "utf8");
  assert.ok(!/location\.hash|URLSearchParams|replaceState|pushState|createObjectURL/.test(source), "the page writes nothing into a URL");
});
