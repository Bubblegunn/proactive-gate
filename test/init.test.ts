import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

// ---- R2-B: several presets, --legal, --minimal, --daily, and a snippet that runs ----------------

const presetIds = (policy: Record<string, unknown>) => (policy.checks as Array<Record<string, string>>).map((c) => c.preset ?? c.id);

test("--preset takes a comma list or a repeated flag, lands in the order named, and prints every source", () => {
  const { policy, message } = plan({ preset: ["usTcpa", "krNetworkAct50"], out: "p.json" });
  assert.deepEqual(presetIds(JSON.parse(policy)).slice(-3), ["usTcpa", "krNetworkAct50", "dailyBudget"]);
  for (const name of ["usTcpa", "krNetworkAct50"]) for (const source of presets[name]!.sources) assert.ok(message.includes(source), source);
  assert.throws(() => plan({ preset: ["usTcpa", "nope"], out: "p.json" }), /unknown preset "nope".*usTcpa/s, "one unknown name in a list fails the whole list");

  const dir = mkdtempSync(join(tmpdir(), "pg-init-list-"));
  try {
    const comma = join(dir, "comma.json");
    const repeated = join(dir, "repeated.json");
    execFileSync(process.execPath, [cli, "init", "--preset", "usTcpa,krNetworkAct50", "--out", comma], { encoding: "utf8" });
    execFileSync(process.execPath, [cli, "init", "--preset", "usTcpa", "--preset", "krNetworkAct50", "--out", repeated], { encoding: "utf8" });
    assert.deepEqual(readFileSync(comma, "utf8"), readFileSync(repeated, "utf8"), "the two spellings write the same policy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--legal maps each jurisdiction code to its preset, and an unknown code names the known ones", () => {
  const pairs: Array<[string, string]> = [["us", "usTcpa"], ["eu", "euEprivacy"], ["kr", "krNetworkAct50"], ["in", "inTcccp"], ["br", "brLgpd"]];
  for (const [code, name] of pairs) {
    const { policy } = plan({ legal: [code], out: "p.json" });
    assert.deepEqual(presetIds(JSON.parse(policy)).slice(-2), [name, "dailyBudget"], code);
  }
  const { policy } = plan({ legal: ["us", "kr"], preset: ["usTcpa"], out: "p.json" });
  const ids = presetIds(JSON.parse(policy));
  assert.equal(ids.filter((id) => id === "usTcpa").length, 1, "a preset named twice is written once");
  assert.deepEqual(ids.slice(-3), ["usTcpa", "krNetworkAct50", "dailyBudget"]);
  assert.throws(() => plan({ legal: ["xx"], out: "p.json" }), /unknown legal code "xx".*us.*eu.*kr.*in.*br/s);
});

test("--minimal writes the short policy from the skill, with the budget limit it is given", () => {
  const policy = buildPolicy(undefined, { minimal: true }) as unknown as Policy;
  assert.deepEqual(
    (policy.checks as Array<Record<string, unknown>>).map((c) => c.id),
    ["consent", "dedupe", "snooze", "quietHours", "dailyBudget"],
  );
  assert.equal(compilePolicy(policy).checks.length, 5);
  assert.equal((policy.checks as Array<Record<string, unknown>>).at(-1)!.limit, 3, "three per user per day by default");
  const seven = buildPolicy(undefined, { minimal: true, daily: 7 }) as unknown as Policy;
  assert.equal((seven.checks as Array<Record<string, unknown>>).at(-1)!.limit, 7, "--daily sets the limit");
  const withPreset = buildPolicy("usTcpa", { minimal: true }) as unknown as Policy;
  assert.deepEqual(presetIds(withPreset as unknown as Record<string, unknown>).slice(-2), ["usTcpa", "dailyBudget"], "a preset still lands before the budget");
});

test("--daily must be a whole number of 1 or more, for either policy", () => {
  assert.throws(() => plan({ daily: 0, out: "p.json" }), /--daily/);
  assert.throws(() => plan({ daily: 2.5, minimal: true, out: "p.json" }), /--daily/);
  const full = JSON.parse(plan({ daily: 2, out: "p.json" }).policy) as { checks: Array<Record<string, unknown>> };
  assert.equal(full.checks.at(-1)!.limit, 2, "the full policy's budget takes --daily too");
});

test("the none snippet is at most twelve lines, and the printed text ends with the three-line replay hint", () => {
  assert.ok(snippetFor("none", "p.json").split("\n").length <= 12);
  const { message } = plan({ out: "p.json" });
  const tail = message.split("\n").slice(-3);
  assert.match(tail[0]!, /replay a day/);
  assert.match(tail[1]!, /^ {2}npx proactive-gate simulate --dump-events /);
  assert.match(tail[2]!, /^ {2}npx proactive-gate replay \S+ --policy p\.json --commit$/);
});

test("the none snippet, as init prints it, runs against the built library and takes both branches", () => {
  const dir = mkdtempSync(join(tmpdir(), "pg-snippet-"));
  try {
    const { policy } = plan({ minimal: true, out: "policy.json" });
    writeFileSync(join(dir, "policy.json"), policy);
    mkdirSync(join(dir, "node_modules"));
    symlinkSync(join(import.meta.dirname, "..", ".."), join(dir, "node_modules", "proactive-gate"), "dir");
    const snippet = snippetFor("none", "policy.json");
    for (const [consent, expected] of [[true, "sent c1"], [false, "not sent consent"]] as const) {
      writeFileSync(
        join(dir, "run.mjs"),
        `const user = { id: "u1", consent: ${consent} };\nconst candidate = { id: "c1", type: "reminder" };\nconst send = async (c) => console.log("sent", c.id);\nconst log = { info: (fields, text) => console.log(text, fields.rejectedBy) };\n${snippet}\n`,
      );
      const run = spawnSync(process.execPath, ["run.mjs"], { cwd: dir, encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout.trim(), expected);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI help names --minimal, --legal and --daily, and init --legal writes the legal presets", () => {
  const help = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  for (const flag of ["--minimal", "--legal", "--daily"]) assert.match(help, new RegExp(`^ {2}${flag} `, "m"), `${flag} has its own line in the help`);
  const dir = mkdtempSync(join(tmpdir(), "pg-init-legal-"));
  try {
    const out = join(dir, "policy.json");
    const text = execFileSync(process.execPath, [cli, "init", "--minimal", "--legal", "us", "--out", out], { encoding: "utf8" });
    assert.ok(text.includes("https://www.law.cornell.edu/cfr/text/47/64.1200"), "the legal source is printed");
    assert.deepEqual(presetIds(JSON.parse(readFileSync(out, "utf8"))).slice(-2), ["usTcpa", "dailyBudget"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
