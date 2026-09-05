import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPolicy, FRAMEWORKS, plan, snippetFor } from "../src/init.js";
import { compilePolicy, createGate, MemoryStore, presets } from "../src/index.js";
import type { Policy } from "../src/index.js";

const cli = join(import.meta.dirname, "..", "..", "dist", "src", "cli.js");

test("the policy init writes compiles, and the gate it builds runs", async () => {
  const policy = buildPolicy() as unknown as Policy;
  const compiled = compilePolicy(policy);
  assert.deepEqual(
    compiled.checks.map((c) => c.id),
    ["consent", "enabled", "mode", "snooze", "mute", "intensity", "quietHours", "trustRamp", "dismissalCooldown", "dailyBudget"],
  );
  const gate = createGate({ policy, store: new MemoryStore() });
  const decision = await gate.evaluate({
    user: { id: "u1", consent: false },
    candidate: { id: "c1", type: "reminder" },
    now: new Date("2026-09-04T10:00:00Z"),
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.rejectedBy, "consent");
});

test("a preset lands before the budget and still compiles", () => {
  const policy = buildPolicy("usTcpa") as unknown as Policy;
  const ids = (policy.checks as Array<Record<string, string>>).map((c) => c.preset ?? c.id);
  assert.equal(ids.at(-2), "usTcpa", "the preset sits just before the budget");
  assert.equal(ids.at(-1), "dailyBudget");
  assert.ok(compilePolicy(policy).checks.length > 10);
});

test("every preset init offers compiles into a gate", () => {
  for (const name of Object.keys(presets)) {
    const policy = buildPolicy(name) as unknown as Policy;
    assert.doesNotThrow(() => compilePolicy(policy), `preset ${name} does not compile`);
  }
});

test("an unknown preset or framework names the known ones", () => {
  assert.throws(() => plan({ preset: "nope", out: "p.json" }), /unknown preset "nope".*usTcpa/s);
  assert.throws(() => plan({ framework: "nope" as never, out: "p.json" }), /unknown framework "nope".*mastra/s);
});

test("each framework snippet imports its own subpath and names the policy file", () => {
  const subpaths: Record<string, string> = {
    "ai-sdk": "proactive-gate/ai-sdk",
    mastra: "proactive-gate/mastra",
    langchain: "proactive-gate/langchain",
    "openai-agents": "proactive-gate/openai-agents",
    none: "proactive-gate",
  };
  for (const framework of FRAMEWORKS) {
    const snippet = snippetFor(framework, "my.policy.json");
    assert.match(snippet, new RegExp(subpaths[framework]!.replace("/", "\\/")), framework);
    assert.match(snippet, /my\.policy\.json/, framework);
  }
});

test("init writes the file, prints the sources, and refuses to overwrite without --force", () => {
  const dir = mkdtempSync(join(tmpdir(), "pg-init-"));
  try {
    const out = join(dir, "policy.json");
    const first = execFileSync(process.execPath, [cli, "init", "--preset", "usTcpa", "--framework", "langchain", "--out", out], { encoding: "utf8" });
    assert.match(first, /wrote /);
    assert.match(first, /47 CFR 64\.1200/, "the preset note and its source are printed, not just written");
    assert.match(first, /proactive-gate\/langchain/);
    assert.doesNotThrow(() => compilePolicy(JSON.parse(readFileSync(out, "utf8")) as Policy));

    let refused = "";
    try {
      execFileSync(process.execPath, [cli, "init", "--out", out], { encoding: "utf8", stdio: "pipe" });
    } catch (error) {
      refused = String((error as { stderr?: string }).stderr ?? "");
    }
    assert.match(refused, /already exists.*--force/);

    writeFileSync(out, "{}");
    execFileSync(process.execPath, [cli, "init", "--out", out, "--force"], { encoding: "utf8" });
    assert.doesNotThrow(() => compilePolicy(JSON.parse(readFileSync(out, "utf8")) as Policy), "--force rewrites a valid policy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init --list names every preset and framework", () => {
  const text = execFileSync(process.execPath, [cli, "init", "--list"], { encoding: "utf8" });
  for (const name of Object.keys(presets)) assert.match(text, new RegExp(name), name);
  for (const framework of FRAMEWORKS) assert.match(text, new RegExp(framework));
});
