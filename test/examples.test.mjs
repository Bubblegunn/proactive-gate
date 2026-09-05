import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The runnable adapter examples import "proactive-gate" by name (Node's package
// self-reference through the exports map), so they exercise the same subpaths a user gets.
const run = (script) => spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], { encoding: "utf8" });

test("mastra example runs offline and stops the right candidates", () => {
  const result = run("../examples/mastra/run.mjs");
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  const sent = lines.filter((l) => l.startsWith("send ")).length;
  const stopped = lines.filter((l) => l.startsWith("stopped ")).length;
  assert.equal(sent, 5);
  assert.equal(stopped, 5);
  assert.equal(lines.at(-1), "10 candidates, 5 sent, 5 stopped by the processor");
  assert.match(result.stdout, /stopped m1  proactive-gate: rejected by quietHours/);
  assert.match(result.stdout, /stopped m3  proactive-gate: rejected by intensity/);
  assert.match(result.stdout, /stopped m6  proactive-gate: rejected by dailyBudget/);
  assert.match(result.stdout, /stopped n1  proactive-gate: rejected by trustRamp/);
  assert.match(result.stdout, /stopped n3  proactive-gate: rejected by mode/);
});

test("ai-sdk example answers every approval request with the gate's reason", () => {
  const result = run("../examples/ai-sdk/run.mjs");
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.filter((l) => l.startsWith("approved ")).length, 3);
  assert.equal(lines.filter((l) => l.startsWith("denied ")).length, 6);
  assert.equal(lines.at(-1), "9 approval requests, 3 approved, 6 denied");
  assert.match(result.stdout, /denied {3}apr_01 .*\n {9}rejected by quietHours/);
  assert.match(result.stdout, /denied {3}apr_04 .*\n {9}rejected by dailyBudget/);
  assert.match(result.stdout, /denied {3}apr_05 .*\n {9}rejected by window:tcpa/);
  // A critical alert still cannot pass a legal window: presets carry no priority bypass.
  assert.match(result.stdout, /denied {3}apr_06 .*\n {9}rejected by window:tcpa/);
  assert.match(result.stdout, /denied {3}apr_07 .*\n {9}rejected by trustRamp/);
  assert.match(result.stdout, /denied {3}apr_09 .*\n {9}rejected by consent/);
});
