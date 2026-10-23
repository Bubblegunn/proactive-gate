// Verifies one build of proactive-gate BEFORE any arm runs against it.
//
//   node probe.mjs --ours DIR --tarball TGZ --commit HASH
//
// 1. Static checks on DIR, the plugin directory that the "ours" arm loads: the plugin manifest, the skill (at most
//    46 lines), the trigger hook and package.json.
// 2. Installs TGZ into a fresh temp folder with the Node 22+ folder from H2H_NODE_BIN first on PATH, then runs a
//    feature probe through the INSTALLED package: createGate with presets.assistantNudge, the gate methods the
//    skill relies on, and `proactive-gate scaffold nudge`.
// Every miss is printed as FAIL; the exit code is 1 when any check fails. Nothing is run against the arms.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const dir = flag("--ours");
const tarball = flag("--tarball");
const commit = flag("--commit");
if (!dir || !tarball || !commit) {
  console.error("usage: node probe.mjs --ours DIR --tarball TGZ --commit HASH");
  process.exit(2);
}
const nodeBin = process.env.H2H_NODE_BIN;
if (!nodeBin) {
  console.error("H2H_NODE_BIN is not set (the folder holding node 22 or newer)");
  process.exit(2);
}
const plugin = resolve(dir);
const tgz = resolve(tarball);
const env = { ...process.env, PATH: `${nodeBin}:${process.env.PATH}` };

let failures = 0;
const pass = (msg) => console.log(`ok    ${msg}`);
const miss = (msg) => { failures += 1; console.log(`FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? pass(msg) : miss(msg));

console.log(`commit under test: ${commit}`);
const sha256 = createHash("sha256").update(readFileSync(tgz)).digest("hex");
console.log(`tarball: ${tgz}`);
console.log(`tarball sha256: ${sha256}`);

// 1. static checks on the plugin directory
const manifestPath = join(plugin, ".claude-plugin/plugin.json");
let manifest = null;
if (existsSync(manifestPath)) {
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { manifest = null; }
}
check(manifest !== null, `plugin manifest is readable JSON: ${manifestPath}`);

const skillPath = join(plugin, "skills/proactive-gate/SKILL.md");
if (existsSync(skillPath)) {
  const text = readFileSync(skillPath, "utf8");
  const lines = text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
  check(lines <= 46, `skills/proactive-gate/SKILL.md has at most 46 lines (found ${lines})`);
} else {
  miss(`skills/proactive-gate/SKILL.md exists under ${plugin}`);
}
check(existsSync(join(plugin, "hooks/trigger.sh")), "hooks/trigger.sh exists");

let pkg = null;
try { pkg = JSON.parse(readFileSync(join(plugin, "package.json"), "utf8")); } catch { pkg = null; }
check(pkg !== null && pkg.name === "proactive-gate", "package.json name is proactive-gate");
check(pkg !== null && typeof pkg.version === "string" && pkg.version.length > 0, `package.json version is set (${pkg?.version ?? "missing"})`);

// 2. install the tarball into a fresh folder and probe the installed package
const work = mkdtempSync(join(tmpdir(), "h2h-probe-"));
writeFileSync(join(work, "package.json"), JSON.stringify({ name: "h2h-probe", private: true, type: "module", version: "0.0.0" }));
const run = (cmd, cmdArgs, cwd = work) => spawnSync(cmd, cmdArgs, { cwd, env, encoding: "utf8", timeout: 300_000 });

const nodeVersion = run("node", ["-v"]);
const major = Number((nodeVersion.stdout ?? "").trim().replace(/^v/, "").split(".")[0]);
check(major >= 22, `node on the probe PATH is 22 or newer (${(nodeVersion.stdout ?? "").trim() || "not found"})`);

const install = run("npm", ["install", "--no-audit", "--no-fund", "--silent", tgz]);
check(install.status === 0, `npm install of the tarball succeeds${install.status === 0 ? "" : `: ${(install.stderr ?? "").slice(0, 400)}`}`);

const installedPkgPath = join(work, "node_modules/proactive-gate/package.json");
let installed = null;
try { installed = JSON.parse(readFileSync(installedPkgPath, "utf8")); } catch { installed = null; }
check(installed !== null, "the installed package has a package.json");
check(installed !== null && pkg !== null && installed.version === pkg.version, `installed version ${installed?.version ?? "?"} equals the version in DIR ${pkg?.version ?? "?"}`);

const feature = `
import { createGate, MemoryStore, presets } from "proactive-gate";
const out = {};
const safe = (key, fn) => { try { out[key] = fn(); } catch (e) { out[key] = "threw: " + (e && e.message); } };
out.createGate = typeof createGate;
out.nudge = typeof presets?.assistantNudge;
let gate = null;
safe("gateBuilt", () => { gate = createGate({ checks: presets.assistantNudge(), store: new MemoryStore() }); return true; });
const now = new Date("2026-10-22T12:00:00Z");
const user = { id: "u1", consent: true, consents: { marketing: true }, deviceTimezone: "Europe/Istanbul", createdAt: "2026-07-01T00:00:00Z" };
const candidate = { id: "c1", type: "insight" };
out.release = typeof gate?.release;
out.evaluateSync = typeof gate?.evaluateSync;
out.whenAllowed = typeof gate?.whenAllowed;
out.inbound = typeof gate?.inbound === "object" && gate?.inbound !== null ? "object" : String(typeof gate?.inbound);
safe("syncDecisionAllowedType", () => { const d = gate.evaluateSync({ user, candidate, now }); return typeof d.allowed; });
safe("syncDecisionRejectedBy", () => { const d = gate.evaluateSync({ user, candidate, now }); return d.allowed ? "(allowed)" : String(d.rejectedBy); });
console.log(JSON.stringify(out));
`;
writeFileSync(join(work, "feature.mjs"), feature);
const probe = run("node", ["feature.mjs"]);
let got = null;
try { got = JSON.parse((probe.stdout ?? "").trim().split("\n").pop()); } catch { got = null; }
if (probe.status !== 0 || got === null) {
  miss(`feature probe ran through the installed package: ${(probe.stderr || probe.stdout || "no output").slice(0, 400)}`);
} else {
  check(got.createGate === "function", "createGate is exported from the installed package");
  check(got.nudge === "function", "presets.assistantNudge is exported");
  check(got.gateBuilt === true, `createGate({ checks: presets.assistantNudge(), store }) builds${got.gateBuilt === true ? "" : `: ${got.gateBuilt}`}`);
  check(got.release === "function", "gate.release is a function");
  check(got.evaluateSync === "function", "gate.evaluateSync is a function");
  check(got.whenAllowed === "function", "gate.whenAllowed is a function");
  check(got.inbound === "object", "gate.inbound is an object");
  check(got.syncDecisionAllowedType === "boolean", `evaluateSync returns a decision with boolean allowed (got ${got.syncDecisionAllowedType})`);
  console.log(`info  evaluateSync on a consenting insight candidate at 2026-10-22T12:00:00Z: ${got.syncDecisionRejectedBy}`);
}

// the scaffold command in the installed package
const scaffoldDir = join(work, "scaffold");
const scaffold = run("node", ["node_modules/.bin/proactive-gate", "scaffold", "nudge", "--out", scaffoldDir]);
check(scaffold.status === 0, `proactive-gate scaffold nudge exits 0${scaffold.status === 0 ? "" : `: ${(scaffold.stderr ?? "").slice(0, 300)}`}`);
for (const name of ["notify.mjs", "proactive-gate.policy.json", "notify.test.mjs"]) {
  check(existsSync(join(scaffoldDir, name)), `scaffold writes ${name}`);
}

if (failures > 0) {
  console.log(`PROBE FAILED: ${failures} check(s) missed. Nothing was run against the arms. Probe folder kept: ${work}`);
  process.exit(1);
}
rmSync(work, { recursive: true, force: true });
console.log("PROBE PASSED");
