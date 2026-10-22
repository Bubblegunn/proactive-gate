import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as api from "../dist/src/index.js";

// `proactive-gate scaffold nudge` writes a policy and a notify module. The generated tests must pass when run
// against the built library, and the notify module may import nothing but the library and Node itself.

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "dist/src/cli.js");
const scaffold = (dir, ...args) => spawnSync(process.execPath, [cli, "scaffold", "nudge", "--out", dir, ...args], { encoding: "utf8" });
const withTempDir = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "scaffold-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const linkLibrary = (dir) => {
  mkdirSync(join(dir, "node_modules"));
  symlinkSync(root, join(dir, "node_modules", "proactive-gate"), "dir");
};
// The outer test runner sets NODE_TEST_CONTEXT, and a child that inherits it skips every file and exits 0.
const generatedTests = (dir) => {
  const env = { ...process.env };
  delete env.STATE_DIR;
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ["--test", "--test-reporter=tap", "notify.test.mjs"], { cwd: dir, encoding: "utf8", env });
};

test("the help names the scaffold command and its flags", () => {
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" }).stdout;
  assert.match(help, /proactive-gate scaffold nudge \[--out DIR\] \[--daily N\] \[--legal us\] \[--force\]/);
});

test("scaffold nudge writes the policy, the notify module and its tests, and the policy compiles", () => {
  withTempDir((dir) => {
    const run = scaffold(dir);
    assert.equal(run.status, 0, run.stderr);
    for (const name of ["proactive-gate.policy.json", "notify.mjs", "notify.test.mjs"]) assert.ok(existsSync(join(dir, name)), name);
    const policy = JSON.parse(readFileSync(join(dir, "proactive-gate.policy.json"), "utf8"));
    assert.equal(policy.specVersion, "1.0.0");
    assert.deepEqual(policy.checks[0], { preset: "assistantNudge", dailyLimit: policy.checks[0].dailyLimit });
    assert.deepEqual(policy.checks[1], { id: "freshness", maxAgeSeconds: 86400 }, "messages older than a day are not sent");
    assert.ok(api.compilePolicy(policy), "the policy compiles");
  });
});

test("the daily limit given with --daily is the one the policy and the generated tests use", () => {
  withTempDir((dir) => {
    assert.equal(scaffold(dir, "--daily", "2").status, 0);
    assert.equal(JSON.parse(readFileSync(join(dir, "proactive-gate.policy.json"), "utf8")).checks[0].dailyLimit, 2);
    linkLibrary(dir);
    const tests = generatedTests(dir);
    assert.equal(tests.status, 0, tests.stdout + tests.stderr);
    assert.match(tests.stdout + tests.stderr, /^# pass [1-9][0-9]*$/m, "the generated tests ran");
    assert.match(tests.stdout + tests.stderr, /^# fail 0$/m);
  });
});

test("the generated tests pass against the built library, with the default limit", () => {
  withTempDir((dir) => {
    assert.equal(scaffold(dir).status, 0);
    linkLibrary(dir);
    const tests = generatedTests(dir);
    assert.equal(tests.status, 0, tests.stdout + tests.stderr);
    assert.match(tests.stdout + tests.stderr, /^# pass [1-9][0-9]*$/m, "the generated tests ran");
    assert.match(tests.stdout + tests.stderr, /^# fail 0$/m);
  });
});

test("the notify module is short and imports only the library and Node", () => {
  withTempDir((dir) => {
    assert.equal(scaffold(dir).status, 0);
    const source = readFileSync(join(dir, "notify.mjs"), "utf8");
    assert.ok(source.split("\n").length <= 190, "at most about 190 lines");
    for (const [, specifier] of source.matchAll(/from "([^"]+)"/g)) assert.ok(specifier.startsWith("node:") || specifier === "proactive-gate", specifier);
  });
});

test("scaffold refuses to overwrite its files without --force, and checks --daily", () => {
  withTempDir((dir) => {
    assert.equal(scaffold(dir).status, 0);
    const again = scaffold(dir);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already exist in .+; pass --force/);
    assert.equal(scaffold(dir, "--force").status, 0);
    for (const bad of ["-1", "2.5", "many"]) {
      const run = scaffold(dir, "--daily", bad);
      assert.equal(run.status, 2, bad);
      assert.match(run.stderr, /--daily takes a whole number/);
    }
  });
});

test("with STATE_DIR set, the module creates the directory, and each decision is one line in the log", () => {
  withTempDir((dir) => {
    assert.equal(scaffold(dir).status, 0);
    linkLibrary(dir);
    const state = join(dir, "missing", "state");
    const code = `import { decide } from "./notify.mjs"; console.log(JSON.stringify(await decide({ user: { id: "u1", consent: true, timezone: "Europe/Istanbul", createdAt: "2026-01-01T00:00:00Z" }, candidate: { type: "nudge", origin: "requested" }, now: new Date("2026-10-21T10:00:00Z") })));`;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: dir, encoding: "utf8", env: { ...process.env, STATE_DIR: state } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).send, true);
    const lines = readFileSync(join(state, "decisions.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).delivered, true);
  });
});

test("STATE_DIR is read at first use: set after the import, switched between cases, and opt-out is shared by a second process", () => {
  withTempDir((dir) => {
    assert.equal(scaffold(dir).status, 0);
    linkLibrary(dir);
    const a = join(dir, "state-a");
    const b = join(dir, "state-b");
    const user = `{ id: "u1", consent: true, timezone: "Europe/Istanbul", createdAt: "2026-01-01T00:00:00Z" }`;
    const ask = `decide({ user: ${user}, candidate: { type: "nudge", origin: "requested" }, now: new Date("2026-10-21T10:00:00Z") })`;
    const late = `import { decide, optOut } from "./notify.mjs"; process.env.STATE_DIR = ${JSON.stringify(a)}; await optOut("u1", "nudge"); const first = await ${ask}; process.env.STATE_DIR = ${JSON.stringify(b)}; const second = await ${ask}; console.log(JSON.stringify([first.send, second.send]));`;
    const env = { ...process.env };
    delete env.STATE_DIR;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", late], { cwd: dir, encoding: "utf8", env });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), [false, true], "opt-out holds in directory a and does not leak into directory b");
    assert.ok(existsSync(join(a, "gate.db")) && existsSync(join(b, "gate.db")));
    const again = `import { decide } from "./notify.mjs"; console.log(JSON.stringify((await ${ask}).send));`;
    const second = spawnSync(process.execPath, ["--input-type=module", "-e", again], { cwd: dir, encoding: "utf8", env: { ...env, STATE_DIR: a } });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout), false, "a new process sees the opt-out from the shared directory");
  });
});

const runModule = (dir, code, env = {}) => {
  const base = { ...process.env };
  delete base.STATE_DIR;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: dir, encoding: "utf8", env: { ...base, ...env } });
};

test("config.dailyNudgeCap on a call sets the daily limit for that call", () => {
  withTempDir((dir) => {
    assert.equal(scaffold(dir).status, 0);
    linkLibrary(dir);
    const code = `import { decide } from "./notify.mjs"; const user = { id: "u1", consent: true, timezone: "Europe/Istanbul", createdAt: "2026-01-01T00:00:00Z" };
const out = []; for (let i = 0; i < 4; i++) out.push((await decide({ user, candidate: { id: "n" + i, type: "tip", origin: "inferred" }, config: { dailyNudgeCap: 2 }, now: new Date("2026-10-21T10:00:00Z") })).send);
console.log(JSON.stringify(out));`;
    const run = runModule(dir, code);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).filter(Boolean).length, 2, "two sent under a cap of 2, the rest refused");
  });
});

test("a push the phone refused gives the unit back even when the in-app item was stored", () => {
  withTempDir((dir) => {
    assert.equal(scaffold(dir, "--daily", "1").status, 0);
    linkLibrary(dir);
    const code = `import { deliver } from "./notify.mjs"; const user = { id: "u1", consent: true, timezone: "Europe/Istanbul", createdAt: "2026-01-01T00:00:00Z", notificationsPermitted: true };
const go = (id, accept) => deliver({ user, candidate: { id, type: "briefing", origin: "requested", surfaces: ["push", "feed"] }, transport: { push: async () => accept, inApp: async () => true }, now: new Date("2026-10-21T10:00:00Z") });
const a = await go("a", false); const b = await go("b", false); const c = await go("c", true); const d = await go("d", true);
console.log(JSON.stringify([a.push, b.push, c.push, d.push]));`;
    const run = runModule(dir, code);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), [false, false, true, false]);
  });
});

test("--legal us adds the US calling hours to the policy, and an 21:00 text is refused in the user's zone", () => {
  withTempDir((dir) => {
    assert.equal(scaffold(dir, "--legal", "us").status, 0);
    const policy = JSON.parse(readFileSync(join(dir, "proactive-gate.policy.json"), "utf8"));
    assert.deepEqual(policy.checks.map((c) => c.preset ?? c.id), ["assistantNudge", "usTcpa", "freshness"]);
    linkLibrary(dir);
    const code = `import { decide } from "./notify.mjs"; const user = { id: "u1", consent: true, timezone: "America/New_York", quietHours: null, createdAt: "2026-01-01T00:00:00Z" };
const at = (iso, id) => decide({ user, candidate: { id, type: "digest", origin: "requested", channel: "sms" }, now: new Date(iso) });
console.log(JSON.stringify([(await at("2026-10-21T00:59:00Z", "a")).send, (await at("2026-10-21T01:00:00Z", "b")).send, (await at("2026-10-21T12:00:00Z", "c")).send, (await at("2026-10-21T11:59:00Z", "d")).send]));`;
    const run = runModule(dir, code);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), [true, false, true, false], "20:59 and 08:00 New York go, 21:00 and 07:59 do not");
  });
});

test("the help text names what notify.mjs exports for an app to call", () => {
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" }).stdout;
  for (const name of ["decide", "deliver", "whyNotReceived", "dryRun", "optOut"]) assert.match(help, new RegExp(name), name);
});

test("scaffold takes only the nudge kind", () => {
  const run = spawnSync(process.execPath, [cli, "scaffold", "digest"], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage: proactive-gate scaffold nudge/);
});
