import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as api from "../dist/src/index.js";
import { TOOLS } from "../dist/src/mcp.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const json = (path) => JSON.parse(read(path));
const pkg = json("package.json");
// SKILL.md is the front page. The guide and the check catalogue are its references; the checks below that
// read the skill as a whole read all three, and the checks about the guide's own layout read the guide.
const skill = read("skills/proactive-gate/SKILL.md");
const guide = read("skills/proactive-gate/references/guide.md");
const checksDoc = read("skills/proactive-gate/references/checks.md");
const all = [skill, guide, checksDoc].join("\n");

test("the plugin manifest, marketplace entry and skill agree with the package", () => {
  const plugin = json(".claude-plugin/plugin.json");
  assert.equal(plugin.name, "proactive-gate");
  assert.equal(plugin.version, pkg.version, "release-gate compares these too");
  assert.equal(plugin.skills, "./skills");
  const market = json(".claude-plugin/marketplace.json");
  assert.deepEqual(market.plugins.map((p) => p.name), ["proactive-gate"]);
  assert.equal(market.plugins[0].source, "./");
  const front = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(all);
  assert.ok(front, "SKILL.md starts with name and description front matter");
  assert.equal(front[1], "proactive-gate", "the name is the directory name");
  assert.ok(front[2].length > 60 && front[2].length <= 1024, "description says when to use it, within the 1024-character limit");
  assert.ok(pkg.files.includes("skills") && pkg.files.includes(".claude-plugin"), "both ship in the npm package");
});

// ---- every API name the skill uses must exist ----------------------------------------------

const declared = (file, name) => {
  const text = readFileSync(new URL(`../dist/src/${file}`, import.meta.url), "utf8");
  const body = new RegExp(`(?:interface|type) ${name}\\b[^{=]*[{=]([\\s\\S]*?)\\n}`).exec(text)?.[1];
  assert.ok(body, `${name} not found in dist/src/${file}`);
  return new Set([...body.matchAll(/^\s{4}(?:readonly )?(\w+)\??:|^\s{4}(\w+)\??\(/gm)].map((m) => m[1] ?? m[2]));
};
const members = {
  gate: declared("gate.d.ts", "Gate"),
  decision: declared("types.d.ts", "Decision"),
  checks: new Set(Object.keys(api.checks)),
  presets: new Set(Object.keys(api.presets)),
};
const fields = new Set([...declared("types.d.ts", "UserState"), ...declared("types.d.ts", "Candidate"), ...declared("types.d.ts", "QuietWindow"), ...declared("types.d.ts", "Decision")]);
// fileURLToPath, not URL.pathname: on Windows the pathname is "/D:/…" and node cannot open it.
const help = spawnSync(process.execPath, [fileURLToPath(new URL("../dist/src/cli.js", import.meta.url)), "--help"], { encoding: "utf8" }).stdout;
const subcommands = new Set([...help.matchAll(/proactive-gate (\w+)/g)].map((m) => m[1]));
const flags = new Set(help.match(/--[\w-]+/g));
const words = new Set(["true", "false", "null", "low", "normal", "high", "critical", "reject", "defer", "summary", "checks", "preset", "id", "HH:MM", "policy", "events"]);
// The rejection id a legal window returns, read from the library rather than typed here.
const tcpaRejection = (await api.createGate({ policy: { specVersion: "1.0.0", checks: [{ preset: "usTcpa" }] }, store: new api.MemoryStore() }).evaluate({ user: { id: "t", consent: true, timezone: "America/New_York" }, candidate: { id: "t", type: "t", channel: "sms" }, now: new Date("2026-10-21T02:00:00Z") })).rejectedBy;
const policySchemaText = JSON.stringify(typeof api.policySchema === "function" ? api.policySchema() : api.policySchema);
const tools = new Set(TOOLS.map((t) => t.name));
const inboundIds = new Set(api.createGate({ policy: { specVersion: "1.0.0", checks: [{ id: "consent" }] }, store: new api.MemoryStore(), inboundConsent: true }).checks.map((c) => c.id));
const gateOptions = declared("types.d.ts", "GateOptions");

/** Everything the skill puts in backticks or code fences, classified; anything unclassified fails. */
function problems(text) {
  const found = [];
  const bad = [];
  const note = (kind, token, ok) => { found.push(kind); if (!ok) bad.push(`${kind}: ${token}`); };

  for (const [, names, specifier] of text.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["'](proactive-gate(?:\/[\w-]+)?)["']/g)) {
    assert.equal(specifier, "proactive-gate", "the skill imports from the main entry only");
    for (const name of names.split(",").map((n) => n.trim())) note("import", name, name in api);
  }
  for (const [, object, member] of text.matchAll(/(?<![\w/.-])(gate|decision|checks|presets)\.(\w+)/g)) note("member", `${object}.${member}`, members[object].has(member));
  for (const [, name] of text.matchAll(/"preset":\s*"([^"]+)"/g)) note("preset", name, name in api.presets);
  for (const [, name] of text.matchAll(/^\s*\{\s*"id":\s*"([^"]+)"/gm)) note("check", name, name in api.KNOWN_CHECKS); // a policy line starts with { "id"; a sample record starts with {"user"
  for (const [, sub] of text.matchAll(/npx proactive-gate (\w+)/g)) note("subcommand", sub, subcommands.has(sub));
  for (const [flag] of text.matchAll(/--[a-z][\w-]*/g)) note("flag", flag, flags.has(flag));
  for (const [, token] of text.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) {
    if (/^(npx|npm|pip|claude|node) /.test(token) || /\.(json|jsonl|ts|md|mjs)$/.test(token) || /^\{.*\}$/.test(token) || token.includes("(")) continue;
    if (/^\w+\.\w+$/.test(token) || /^presets\.\w+\.(note|sources)$/.test(token)) continue; // checked above as gate./decision./presets. members
    if (/^--/.test(token)) { note("flag", token.split(" ")[0], flags.has(token.split(" ")[0])); continue; } // "--legal us": the flag, then its value
    if (token === tcpaRejection) { note("name", token, true); continue; }
    if (/^"/.test(token) || words.has(token) || token in api.KNOWN_CHECKS) continue;
    if (/^\w+$/.test(token)) note("name", token, token in api || fields.has(token) || tools.has(token) || ["commit", "evaluate", "whenAllowed", "handle"].includes(token) || ["MemoryStore"].includes(token) || inboundIds.has(token) || gateOptions.has(token) || token in api.presets || subcommands.has(token) || policySchemaText.includes(`"${token}"`));
    else note("unclassified", token, false);
  }
  for (const [, token] of text.matchAll(/\b(explain)\(/g)) note("call", token, token in api);
  return { found, bad };
}

test("the CLI help, which lists the subcommands and flags, was read", () => {
  assert.match(help, /^usage: proactive-gate simulate/);
});

test("every API name, option, preset, check id, subcommand and flag the skill mentions exists", () => {
  const { found, bad } = problems(all);
  assert.deepEqual(bad, []);
  for (const kind of ["import", "member", "preset", "subcommand", "flag", "name", "call"]) assert.ok(found.includes(kind), `the skill no longer mentions anything of kind "${kind}", so this test would check nothing for it`);
});

test("the names the skill is built around are still the library's", () => {
  for (const name of ["createGate", "MemoryStore", "RedisStore", "PostgresStore", "SqliteStore", "explain"]) assert.ok(name in api, name);
  for (const name of ["evaluate", "commit"]) assert.ok(members.gate.has(name), name);
  for (const name of ["allowed", "rejectedBy", "reason", "nextAllowedAt", "deferredBy", "retryAt", "trace", "surfaces"]) assert.ok(members.decision.has(name), name);
});

test("the checker rejects a skill that cites a name the library does not export", () => {
  for (const [broken, expected] of [
    [all.replace("gate.commit(", "gate.committ("), /member: gate\.committ/],
    [all.replace("import { createGate, SqliteStore, explain }", "import { createGates, SqliteStore, explain }"), /import: createGates/],
    [all.replace('"usTcpa"', '"usTcpaa"'), /preset: usTcpaa/],
    [all.replace("decision.nextAllowedAt)", "decision.nextAllowedTime)"), /member: decision\.nextAllowedTime/],
    [all.replace("npx proactive-gate replay", "npx proactive-gate replays"), /subcommand: replays/],
    [all.replace("`PostgresStore`", "`PostgresStor`"), /name: PostgresStor/],
  ]) assert.match(problems(broken).bad.join("\n"), expected);
});

// ---- the rewritten skill: a working policy, the inbound snippet, the new words ---------------

test("the skill names the steps and functions the rewrite depends on", () => {
  for (const word of ["node -v", "dedupeKey", "whenAllowed", "inboundConsent", "gate.inbound", "simulate"]) assert.ok(all.includes(word), `SKILL.md must mention ${word}`);
});

test("the first JSON block in the skill is a policy that compiles and evaluates", async () => {
  const block = /```json\n([\s\S]*?)```/.exec(all);
  assert.ok(block, "SKILL.md has a json block");
  const policy = JSON.parse(block[1]);
  const ids = policy.checks.map((c) => c.id);
  for (const id of ids) assert.ok(id in api.KNOWN_CHECKS, `check id ${id} from the policy block exists`);
  assert.ok(api.compilePolicy(policy), "compilePolicy accepts the block");
  const gate = api.createGate({ policy, store: new api.MemoryStore() });
  assert.deepEqual(gate.checks.map((c) => c.id), ids, "the gate runs the checks in the order the block lists them");
  const now = new Date("2026-10-21T10:00:00Z");
  const candidate = { id: "c1", type: "reminder" };
  const allowed = await gate.evaluate({ user: { id: "u1", consent: true, timezone: "UTC" }, candidate, now });
  assert.equal(allowed.allowed, true, allowed.reason);
  const refused = await gate.evaluate({ user: { id: "u2", consent: false, timezone: "UTC" }, candidate, now });
  assert.equal(refused.allowed, false);
  assert.equal(refused.rejectedBy, "consent");
});

test("the inbound snippet does what the skill says: STOP silences one channel until START", async () => {
  const gate = api.createGate({ policy: { specVersion: "1.0.0", checks: [{ id: "consent" }] }, store: new api.MemoryStore(), inboundConsent: true });
  const user = { id: "u1", consent: true };
  const now = new Date("2026-10-21T10:00:00Z");
  const sms = { id: "m1", type: "reminder", channel: "sms" };
  const email = { id: "m2", type: "reminder", channel: "email" };
  const evaluate = (candidate) => gate.evaluate({ user, candidate, now });

  assert.equal((await gate.inbound.handle({ userId: user.id, channel: "sms", text: " stop. " })).action, "stop");
  const refused = await evaluate(sms);
  assert.equal(refused.allowed, false);
  assert.equal(refused.rejectedBy, "inboundConsent");
  assert.equal((await evaluate(email)).allowed, true, "a stop on sms does not silence email");

  assert.equal((await gate.inbound.handle({ userId: user.id, channel: "sms", text: "stop it" })).action, "none", "a sentence is not a keyword");
  assert.equal((await gate.inbound.handle({ userId: user.id, channel: "sms", text: "START" })).action, "start");
  assert.equal((await evaluate(sms)).allowed, true, "START re-enables the channel");
});

test("the replay commands the skill gives run, and the log line it shows is a valid input", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-replay-"));
  const cli = fileURLToPath(new URL("../dist/src/cli.js", import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8" });
  const line = /^\{"user":.*\}$/m.exec(all)?.[0];
  assert.ok(line, "SKILL.md shows one log line");
  const input = JSON.parse(line);
  assert.ok(input.user && input.candidate && input.now, "the line has user, candidate and now");

  const dump = run("simulate", "--dump-events", "week.jsonl");
  assert.equal(dump.status, 0, dump.stderr);
  const written = Number(/wrote (\d+) events/.exec(dump.stdout)?.[1]);
  const lines = readFileSync(join(dir, "week.jsonl"), "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, written, "the dump holds every event it reports");

  for (const [name, policy] of [["current.json", { specVersion: "1.0.0", checks: [{ id: "consent" }, { id: "dailyBudget", limit: 3 }] }], ["proposed.json", { specVersion: "1.0.0", checks: [{ id: "consent" }, { id: "dailyBudget", limit: 5 }] }]]) {
    writeFileSync(join(dir, name), JSON.stringify(policy));
  }
  const compare = run("simulate", "week.jsonl", "--policy", "current.json", "--policy", "proposed.json", "--disagreements", "--why", "--limit", "0");
  assert.equal(compare.status, 0, compare.stderr);
  assert.match(compare.stdout, /the policies disagreed about \d+ of \d+ candidates/);
  const replayed = run("replay", "week.jsonl", "--policy", "current.json");
  assert.equal(replayed.status, 0, replayed.stderr);
  rmSync(dir, { recursive: true, force: true });
});

// ---- fix round 1: policy order, feature check, names, the loop, the in-code replay -------------

const root = fileURLToPath(new URL("..", import.meta.url));
const firstJson = () => JSON.parse(/```json\n([\s\S]*?)```/.exec(all)[1]);
const jsBlock = (marker) => [...all.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]).find((b) => b.includes(marker));
const AsyncFunction = (async () => {}).constructor;

test("in the skill's policy, a duplicate delivery spends one budget unit, not two", async () => {
  const gate = api.createGate({ policy: firstJson(), store: new api.MemoryStore() });
  const user = { id: "u1", consent: true, timezone: "UTC" };
  const now = new Date("2026-10-21T10:00:00Z");
  const input = () => ({ user, candidate: { id: "m1", type: "reminder", dedupeKey: "order:42:shipped" }, now });
  const first = await gate.evaluate(input());
  const second = await gate.evaluate(input());
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true, "both evaluations pass before either commit");
  assert.equal(await gate.commit(first, input()), true);
  assert.equal(await gate.commit(second, input()), false, "dedupe claims the event once");
  assert.equal(await gate.commit(first, input()), true, "a second commit of the same decision returns the first answer");
  assert.equal((await gate.inspect(user, now)).budgetUsed, 1);
});

test("every JSON policy block in the skill compiles, and every check id in it is a known one", () => {
  const blocks = [...all.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
  assert.ok(blocks.length >= 2, "the skill shows the base policy and the budget checks");
  for (const policy of blocks) {
    api.compilePolicy(policy);
    for (const check of policy.checks) assert.ok(check.id in api.KNOWN_CHECKS, check.id);
  }
});

test("the feature check in step 1 prints function function on the local build", () => {
  const command = /```bash\n(node -e [^\n]*)\n```/.exec(all)?.[1];
  assert.ok(command, "step 1 has the feature check command");
  const run = spawnSync("sh", ["-c", command], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "function function");
});

test("the names table names what the library returns", async () => {
  const gate = api.createGate({ policy: { specVersion: "1.0.0", checks: [{ preset: "usTcpa" }] }, store: new api.MemoryStore() });
  const at = new Date("2026-10-21T02:00:00Z");
  const refused = await gate.evaluate({ user: { id: "u", consent: true, timezone: "America/New_York" }, candidate: { id: "c", type: "x", channel: "sms" }, now: at });
  assert.equal(refused.rejectedBy, tcpaRejection);
  assert.ok(refused.nextAllowedAt instanceof Date, "a legal window refusal carries the reopening instant");
  assert.ok(all.includes(`\`${tcpaRejection}\``), "the skill names the rejection id");
  const noZone = await gate.evaluate({ user: { id: "u2", consent: true }, candidate: { id: "c", type: "x", channel: "sms" }, now: at });
  assert.equal(noZone.allowed, true, "without user.timezone the window check skips");

  const literal = /^const user = (\{.*\});$/m.exec(all)?.[1];
  assert.ok(literal, "the skill shows a user literal");
  const user = new Function(`return ${literal}`)();
  const snoozed = await api.createGate({ policy: firstJson(), store: new api.MemoryStore() }).evaluate({ user, candidate: { id: "c", type: "x" }, now: new Date("2026-10-21T10:00:00Z") });
  assert.equal(snoozed.deferredBy, "snooze", "the snoozedUntil field in the literal is the one the snooze check reads");
  assert.ok(snoozed.retryAt instanceof Date);
});

test("the decision loop sends only after a true commit, and holds or logs as its rules say", async () => {
  const body = jsBlock("gate.commit(");
  assert.ok(body, "step 4 has the loop");
  const loop = new AsyncFunction("gate", "user", "order", "send", "hold", "log", body);
  const order = { id: 42 };
  const user = { id: "u1" };
  const trace = [];
  const run = async (gate) => {
    const calls = [];
    await loop(gate, user, order,
      async (c) => { trace.push("send"); calls.push(["send", c.id]); },
      (c, at) => calls.push(["hold", c.id, at]),
      (rejectedBy, reason) => calls.push(["log", rejectedBy, reason]),
    );
    return calls;
  };
  const gateWith = ({ first, commit = async () => true, second }) => ({
    evaluate: async () => (calls.n++ === 0 ? first : second),
    commit: async (...args) => { trace.push("commit"); return commit(...args); },
  });
  const calls = { n: 0 };
  const sent = await run(gateWith({ first: { allowed: true, surfaces: ["sms"] } }));
  assert.deepEqual(sent, [["send", "reminder:42"]]);
  assert.deepEqual(trace, ["commit", "send"], "commit ran before the send");

  calls.n = 0;
  const at = new Date("2026-10-22T05:00:00Z");
  const held = await run(gateWith({ first: { allowed: false, nextAllowedAt: at, rejectedBy: "quietHours" } }));
  assert.deepEqual(held, [["hold", "reminder:42", at]]);

  calls.n = 0;
  const logged = await run(gateWith({ first: { allowed: false, rejectedBy: "consent", reason: "no consent" } }));
  assert.deepEqual(logged, [["log", "consent", "no consent"]]);

  calls.n = 0;
  const lost = await run(gateWith({ first: { allowed: true, surfaces: ["sms"] }, commit: async () => false, second: { allowed: false, nextAllowedAt: at, rejectedBy: "dailyBudget" } }));
  assert.deepEqual(lost, [["hold", "reminder:42", at]], "a lost commit with a retry time is held");

  calls.n = 0;
  const dup = await run(gateWith({ first: { allowed: true, surfaces: ["sms"] }, commit: async () => false, second: { allowed: false, rejectedBy: "dedupe", reason: "already delivered" } }));
  assert.deepEqual(dup, [["log", "dedupe", "already delivered"]], "a refusal without nextAllowedAt is logged, not retried");
});

test("the in-code replay in the skill counts what replay --commit counts on the sample week", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-parity-"));
  const cli = fileURLToPath(new URL("../dist/src/cli.js", import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8" });
  try {
    assert.equal(run("simulate", "--dump-events", "week.jsonl").status, 0);
    const policy = firstJson();
    writeFileSync(join(dir, "policy.json"), JSON.stringify(policy));
    const committed = run("replay", "week.jsonl", "--policy", "policy.json", "--commit");
    const plain = run("replay", "week.jsonl", "--policy", "policy.json");
    assert.equal(committed.status, 0, committed.stderr);
    const cliAllowed = Number(/(\d+) allowed/.exec(committed.stdout)?.[1]);
    const plainAllowed = Number(/(\d+) allowed/.exec(plain.stdout)?.[1]);
    const events = readFileSync(join(dir, "week.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const body = jsBlock("in-code replay");
    assert.ok(body, "the skill has the in-code replay");
    const inCode = await new AsyncFunction("createGate", "MemoryStore", "policy", "events", body)(api.createGate, api.MemoryStore, policy, events);
    assert.equal(inCode, cliAllowed, "the in-code recipe and replay --commit agree");
    assert.ok(plainAllowed > cliAllowed, "without --commit the budgets never refuse, so the count is higher");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the preset one-liner in the skill prints one line per preset", () => {
  const command = /```bash\n(node -e "import\('proactive-gate'\)\.then\(m => \{ for[^\n]*)\n```/.exec(all)?.[1];
  assert.ok(command, "the skill has the preset one-liner");
  const run = spawnSync("sh", ["-c", command], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trim().split("\n");
  assert.deepEqual(lines.map((l) => l.split(" ")[0]), Object.keys(api.presets));
});

test("simulate with one --policy compares it against no gate, as the skill says", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-single-"));
  try {
    const cli = fileURLToPath(new URL("../dist/src/cli.js", import.meta.url));
    const dump = spawnSync(process.execPath, [cli, "simulate", "--dump-events", join(dir, "week.jsonl")], { encoding: "utf8" });
    assert.equal(dump.status, 0, dump.stderr);
    writeFileSync(join(dir, "one.json"), JSON.stringify(firstJson()));
    const one = spawnSync(process.execPath, [cli, "simulate", join(dir, "week.jsonl"), "--policy", join(dir, "one.json"), "--limit", "0"], { encoding: "utf8" });
    assert.equal(one.status, 0, one.stderr);
    assert.match(one.stdout, /policies: no gate/);
    assert.ok(all.includes("runs one policy against no gate"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the skill says which refusals carry nextAllowedAt, and a deferral carries it with the same value as retryAt", async () => {
  const row = all.split("\n").find((line) => line.startsWith("| When a deferred message is retried"));
  assert.ok(row && row.includes("decision.retryAt") && row.includes("decision.nextAllowedAt"), "the names table ties retryAt to nextAllowedAt");
  assert.ok(all.includes("budget refusals carry the exact next reset"), "the budget sentence is present");
  assert.ok(all.includes("A `rateLimit` refusal carries none."), "the rateLimit exception is stated");

  const literal = /^const user = (\{.*\});$/m.exec(all)?.[1];
  const user = new Function(`return ${literal}`)();
  const now = new Date("2026-10-21T10:00:00Z");
  const snoozed = await api.createGate({ policy: firstJson(), store: new api.MemoryStore() }).evaluate({ user, candidate: { id: "c", type: "x" }, now });
  assert.equal(snoozed.deferredBy, "snooze");
  assert.equal(snoozed.nextAllowedAt?.getTime(), snoozed.retryAt.getTime(), "a deferral's nextAllowedAt is its retryAt");

  const store = new api.MemoryStore();
  const gate = api.createGate({ policy: { specVersion: "1.0.0", checks: [{ id: "rateLimit", limit: 1, perSeconds: 3600, keyBy: "user" }] }, store });
  const input = { user: { id: "u1", consent: true, timezone: "UTC" }, candidate: { id: "c1", type: "x" }, now };
  const first = await gate.evaluate(input);
  assert.equal(first.allowed, true);
  assert.equal(await gate.commit(first, input), true);
  const second = await gate.evaluate({ ...input, candidate: { id: "c2", type: "x" } });
  assert.equal(second.allowed, false);
  assert.equal(second.nextAllowedAt, undefined, "a rateLimit refusal carries no nextAllowedAt");
});

// ---- R2-B: the ten-line integration, and the policy it writes is the skill's own ----------------

const integration = () => {
  const start = guide.indexOf("## Ten-line integration");
  assert.ok(start >= 0, "the guide has a Ten-line integration section");
  return guide.slice(start).split(/\n## /)[0];
};
const integrationCode = () => /```javascript\n([\s\S]*?)```/.exec(integration())?.[1];
const integrationCommand = () => /```bash\n(npx proactive-gate init [^\n]*)\n```/.exec(integration())?.[1];

test("the ten-line integration sits after step 1 and before step 2, with one init command and at most ten lines of code", () => {
  assert.ok(guide.indexOf("## Step 1") < guide.indexOf("## Ten-line integration"));
  assert.ok(guide.indexOf("## Ten-line integration") < guide.indexOf("## Step 2"));
  assert.equal(integrationCommand(), "npx proactive-gate init --minimal --legal us", "the single command, as the section shows it");
  assert.ok(integrationCode(), "the section has a javascript block");
  assert.ok(integrationCode().trimEnd().split("\n").length <= 10, "the block is at most ten lines");
  for (const name of ["createGate", "SqliteStore", "explain"]) assert.ok(integrationCode().includes(name), name);
  assert.ok(integrationCode().includes("nextAllowedAt") && integrationCode().includes("explain(decision).summary"));
});

// The snippet reads the wall clock (`now: new Date()`) and the minimal policy adds the usTcpa calling
// window, which refuses outside 08:00 to 21:00 in the user's zone. The clock is pinned by a preload that
// replaces the global Date, so the snippet runs unchanged at a fixed daytime instant.
const FIXED_NOW = "2026-09-04T10:00:00.000Z";
const CLOCK_SHIM = `const FIXED = ${JSON.stringify(FIXED_NOW)};
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length === 0) super(FIXED); else super(...args); }
  static now() { return new RealDate(FIXED).getTime(); }
};
`;

test("the ten-line integration runs as written, after the init command it names, against the built library", () => {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Istanbul", hour: "2-digit", hour12: false }).format(new Date(FIXED_NOW)));
  assert.ok(hour >= 8 && hour < 21, "premise: the pinned instant is inside the usTcpa calling window in the test zone");
  const dir = mkdtempSync(join(tmpdir(), "skill-ten-"));
  try {
    const cli = fileURLToPath(new URL("../dist/src/cli.js", import.meta.url));
    const init = spawnSync(process.execPath, [cli, ...integrationCommand().split(" ").slice(2)], { cwd: dir, encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    mkdirSync(join(dir, "node_modules"));
    symlinkSync(root, join(dir, "node_modules", "proactive-gate"), "dir");
    writeFileSync(join(dir, "clock.mjs"), CLOCK_SHIM);
    writeFileSync(
      join(dir, "run.mjs"),
      `${integrationCode()}\nconst allowed = await decide({ id: "u1", consent: true, timezone: "Europe/Istanbul" }, { id: "c1", type: "reminder", channel: "sms" });\nconst refused = await decide({ id: "u2", consent: false, timezone: "Europe/Istanbul" }, { id: "c2", type: "reminder", channel: "sms" });\nimport { readFileSync as read } from "node:fs";\nconst limit = JSON.parse(read("proactive-gate.policy.json", "utf8")).checks.find((c) => c.id === "dailyBudget").limit;\nconst spent = [];\nfor (let i = 0; i <= limit; i++) spent.push((await decide({ id: "u3", consent: true, timezone: "Europe/Istanbul" }, { id: "b" + i, type: "reminder", channel: "sms" })).allowed);\nconsole.log(JSON.stringify({ allowed: allowed.allowed, summary: typeof allowed.summary, refused: refused.allowed, refusedSummary: typeof refused.summary, hasNext: "nextAllowedAt" in refused, spent }));\n`,
    );
    const run = spawnSync(process.execPath, ["--import", "./clock.mjs", "run.mjs"], { cwd: dir, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout.trim().split("\n").at(-1));
    assert.equal(out.allowed, true, "a consenting user is allowed");
    assert.equal(out.summary, "string");
    assert.equal(out.refused, false, "a user without consent is refused");
    assert.equal(out.refusedSummary, "string");
    assert.equal(out.hasNext, true, "the result carries nextAllowedAt");
    const limit = JSON.parse(readFileSync(join(dir, "proactive-gate.policy.json"), "utf8")).checks.find((c) => c.id === "dailyBudget").limit;
    assert.deepEqual(out.spent, [...Array(limit).fill(true), false], "commit spends the budget, so the call after the limit is refused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init --minimal writes the same checks, in the same order, as the skill's first policy block", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-minimal-"));
  try {
    const cli = fileURLToPath(new URL("../dist/src/cli.js", import.meta.url));
    const run = spawnSync(process.execPath, [cli, "init", "--minimal", "--out", join(dir, "policy.json")], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const written = JSON.parse(readFileSync(join(dir, "policy.json"), "utf8"));
    assert.deepEqual(written.checks, firstJson().checks, "the skill and init agree on every check and option");
    assert.equal(written.checks.at(-1).id, "dailyBudget", "the budget comes last, after any preset");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the front page and its references (round 3, L5) --------------------------------------------

test("SKILL.md is a front page of at most 46 lines, front matter included", () => {
  const lines = skill.replace(/\n$/, "").split("\n");
  assert.ok(lines.length <= 46, `SKILL.md has ${lines.length} lines`); // 40 until round 8, which added the kit section
});

test("SKILL.md points to both reference files, and both exist", () => {
  for (const file of ["references/guide.md", "references/checks.md"]) {
    assert.ok(skill.includes(file), `SKILL.md names ${file}`);
    assert.ok(existsSync(new URL(`../skills/proactive-gate/${file}`, import.meta.url)), `${file} exists`);
  }
});

test("the front page opens with the inline checklist of eleven rules, then the library section with the Node check and the scaffold command", () => {
  const inline = skill.indexOf("## Default: write the gate inline");
  const library = skill.indexOf("## Use the library instead when");
  assert.ok(inline >= 0 && library > inline, "the inline checklist comes first, the library section second");
  const checklist = skill.slice(inline, library);
  const rules = [...checklist.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
  assert.deepEqual(rules, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], "the checklist states eleven numbered rules");
  for (const word of ["STATE_DIR", "message id", "STOP", "REVOKE", "OPT OUT", "not enforced", "Rules 1 to 10 always apply"]) assert.ok(checklist.includes(word), `a rule names ${word}`);
  const section = skill.slice(library);
  assert.ok(section.includes("node -v"), "the library section checks the Node version");
  assert.ok(section.includes("npx proactive-gate scaffold nudge --out ."), "the library section runs the scaffold");
  assert.ok(section.indexOf("node -v") < section.indexOf("scaffold nudge"), "the Node check comes before the scaffold command");
  for (const rule of ["requested", "transactional", "commitment"]) assert.ok(section.includes(rule), `the library section names ${rule}`);
});

test("references/checks.md names every check id in KNOWN_CHECKS, in backticks", () => {
  for (const id of Object.keys(api.KNOWN_CHECKS)) assert.ok(checksDoc.includes(`\`${id}\``), `checks.md names ${id}`);
});

test("references/checks.md names the gate functions and the preset the catalogue promises", () => {
  for (const name of ["gate.record", "gate.release", "gate.whenAllowed", "evaluateSync", "assistantNudge"]) assert.ok(checksDoc.includes(name), name);
});

test("the package ships the references, through the skills entry in files", () => {
  const shipped = pkg.files.some((entry) => "skills/proactive-gate/references/checks.md".startsWith(entry.endsWith("/") ? entry : `${entry}/`));
  assert.ok(shipped, "skills/proactive-gate/references/ is inside a files entry");
});

// ---- round 8: the kit, the size cap, the rules that must not come back --------------------------

const kitSource = read("skills/proactive-gate/references/gate-kit.mjs");
const kitNames = new Set([...kitSource.matchAll(/^(?:async )?function (gk\w+)/gm)].map((m) => m[1]));

/** The checks of the round-8 skill text, as a list of problems for any skill text. */
function round8Problems(text) {
  const bad = [];
  if (Buffer.byteLength(text) > 10600) bad.push("the skill is over the 10,600 byte cap");
  const cited = new Set([...text.matchAll(/\b(gk[A-Z]\w*)\(/g)].map((m) => m[1]));
  if (cited.size < 8) bad.push("the skill cites fewer than eight kit functions");
  for (const name of cited) if (!kitNames.has(name)) bad.push(`the kit has no function ${name}`);
  if (!text.includes('cat "${CLAUDE_SKILL_DIR}/references/gate-kit.mjs" >>')) bad.push("the skill does not give the append command");
  if (/use the legal window of the recipient's region/.test(text)) bad.push("the legal-window default is back in rule 6");
  if (!/local clock time with the zone name/.test(text)) bad.push("rule 8 does not ask for local clock time with the zone name");
  if (!/interrupting surface/.test(text)) bad.push("rule 6 lost the per-surface hold");
  if (!/until the end of the recipient's local day/.test(text)) bad.push("rule 5 lost the local-day suppression");
  if (!/any field where the person chose what to receive/.test(text)) bad.push("rule 2 lost the settings-field-is-consent sentence");
  if (!/every repeat of that id gets "not sent: already delivered"/.test(text)) bad.push("rule 5 lost the repeat-never-sends-twice sentence");
  if (!/a saved zone is used as stored, "UTC" included/.test(text)) bad.push("rule 6 lost the UTC placeholder sentence");
  if (/a saved zone of "UTC" or an empty one is unknown/.test(text)) bad.push("rule 6 treats every UTC zone as a placeholder again");
  if (!text.includes("INFO as the whole message (`gkIsHelp(text)`)")) bad.push("rule 7 lost the HELP keyword");
  if (!/neither the data nor the functions/.test(text)) bad.push("rule 2 lost the consent-carrier exception");
  if (!/security alert or code/.test(text)) bad.push("rule 9 lost the security-alert sentence");
  if (!/report a silent in-app item every time/.test(text)) bad.push("rule 5 lost the repeat answer for the in-app item");
  return bad;
}

test("the round-8 skill: size cap, every kit function it cites exists, the append command, and the rule sentences of round 8", () => {
  assert.deepEqual(round8Problems(skill), []);
  assert.ok(kitNames.size >= 16, "the kit defines its functions");
});

test("the round-8 checks reject a skill that regresses each point", () => {
  for (const [broken, expected] of [
    [skill + "x".repeat(10600), /10,600 byte cap/],
    [skill.replaceAll("gkNextOpen(", "gkNextOpened("), /no function gkNextOpened/],
    [skill.replace('cat "${CLAUDE_SKILL_DIR}/references/gate-kit.mjs" >>', "cat gate-kit.mjs >>"), /append command/],
    [skill.replace("never narrow it", "use the legal window of the recipient's region"), /legal-window default/],
    [skill.replace("local clock time with the zone name", "UTC"), /local clock time/],
    [skill.replace("interrupting surface", "surface"), /per-surface/],
    [skill.replace("until the end of the recipient's local day", "forever"), /local-day suppression/],
    [skill.replace("INFO as the whole message (`gkIsHelp(text)`)", "INFO"), /HELP keyword/],
    [skill.replace("neither the data nor the functions", "the functions"), /consent-carrier/],
    [skill.replace("security alert or code", "code"), /security-alert/],
    [skill.replace("any field where the person chose what to receive", "a consent field"), /settings-field/],
    [skill.replace("every repeat of that id gets \"not sent: already delivered\"", "the same answer"), /repeat-never-sends/],
    [skill.replace("a saved zone is used as stored, \"UTC\" included", "a zone"), /UTC placeholder/],
    [skill.replace("a saved zone is used as stored, \"UTC\" included", "a saved zone of \"UTC\" or an empty one is unknown"), /UTC placeholder|every UTC zone/],
    [skill.replace("report a silent in-app item every time", "report it"), /repeat answer/],
  ]) assert.match(round8Problems(broken).join("\n"), expected);
});

test("the append command in the skill produces a working file: the kit appended to a bot.mjs runs and answers", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-kit-"));
  try {
    const skillDir = fileURLToPath(new URL("../skills/proactive-gate", import.meta.url));
    const command = /`(printf '\\n' >> bot\.mjs; cat "\$\{CLAUDE_SKILL_DIR\}\/references\/gate-kit\.mjs" >> bot\.mjs)`/.exec(skill)?.[1];
    assert.ok(command, "the skill shows the append command");
    writeFileSync(join(dir, "bot.mjs"), 'export function check(ms) { return gkNextOpen(ms, "America/New_York", "08:00", "21:00"); }\nconsole.log(check(Date.UTC(2026, 2, 8, 6, 0)));\n');
    const run = spawnSync("sh", ["-c", `${command.replace("${CLAUDE_SKILL_DIR}", skillDir)} && node bot.mjs`], { cwd: dir, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), String(Date.UTC(2026, 2, 8, 12, 0)), "08:00 EDT on the spring-forward day is 12:00Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
