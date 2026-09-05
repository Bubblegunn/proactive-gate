#!/usr/bin/env node
// Structural validation of every fixture and example policy, with no dependencies.
// It is not a full JSON Schema validator: it checks the shape the schemas describe.
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const specVersion = (await readFile(join(root, "spec/SPEC_VERSION"), "utf8")).trim();
const OUTCOMES = new Set(["pass", "reject", "adjust", "skip", "defer"]);
const PRIORITIES = new Set(["low", "normal", "high", "critical"]);
const failures = [];
const fail = (file, message) => failures.push(`${file}: ${message}`);

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else if (entry.name.endsWith(".json")) out.push(path);
  }
  return out.sort();
}

function checkPolicy(file, policy) {
  if (typeof policy !== "object" || policy === null) return fail(file, "policy must be an object");
  if (!/^\d+\.\d+\.\d+$/.test(policy.specVersion ?? "")) fail(file, "policy.specVersion must be semver");
  if (policy.onStoreError !== undefined && !["open", "closed"].includes(policy.onStoreError)) fail(file, "policy.onStoreError");
  if (!Array.isArray(policy.checks) || !policy.checks.length) return fail(file, "policy.checks must be a non-empty array");
  policy.checks.forEach((entry, i) => {
    const hasId = typeof entry.id === "string";
    const hasPreset = typeof entry.preset === "string";
    if (hasId === hasPreset) fail(file, `checks[${i}] needs exactly one of id or preset`);
    if (entry.shadow !== undefined && typeof entry.shadow !== "boolean") fail(file, `checks[${i}].shadow must be boolean`);
  });
  for (const key of Object.keys(policy)) if (!["specVersion", "onStoreError", "keyPrefix", "checks"].includes(key)) fail(file, `unknown policy key ${key}`);
}

function checkFixture(file, fx) {
  for (const key of ["spec_version", "since", "name", "description", "policy", "tests"]) if (!(key in fx)) fail(file, `missing ${key}`);
  for (const key of Object.keys(fx)) if (!["spec_version", "since", "name", "description", "policy", "store_seed", "tests"].includes(key)) fail(file, `unknown key ${key}`);
  if (fx.spec_version !== specVersion) fail(file, `spec_version ${fx.spec_version} is not ${specVersion}`);
  if (!/^[a-z0-9-]+\/[a-z0-9-]+$/.test(fx.name ?? "")) fail(file, "name must be area/name");
  const expectedName = relative(join(root, "spec/fixtures"), file).split(sep).join("/").replace(/\.json$/, "");
  if (fx.name !== expectedName) fail(file, `name ${fx.name} does not match path ${expectedName}`);
  checkPolicy(file, fx.policy);
  if (fx.store_seed) for (const [k, v] of Object.entries(fx.store_seed)) if (typeof v !== "string") fail(file, `store_seed.${k} must be a string`);
  if (!Array.isArray(fx.tests) || !fx.tests.length) return fail(file, "tests must be a non-empty array");
  fx.tests.forEach((t, i) => {
    const at = `tests[${i}]`;
    for (const key of Object.keys(t)) if (!["description", "input", "commit", "expect"].includes(key)) fail(file, `${at} unknown key ${key}`);
    if (!t.input?.user?.id || typeof t.input.user.consent !== "boolean") fail(file, `${at}.input.user needs id and consent`);
    if (!t.input?.candidate?.id || !t.input.candidate.type) fail(file, `${at}.input.candidate needs id and type`);
    if (t.input?.candidate?.priority && !PRIORITIES.has(t.input.candidate.priority)) fail(file, `${at} bad priority`);
    if (typeof t.input?.now !== "string" || !t.input.now.endsWith("Z")) fail(file, `${at}.input.now must be a UTC instant ending in Z`);
    const e = t.expect ?? {};
    if (typeof e.allowed !== "boolean") fail(file, `${at}.expect.allowed must be boolean`);
    if (!Array.isArray(e.trace) || e.trace.some((x) => typeof x !== "string")) fail(file, `${at}.expect.trace must be an array of check ids`);
    for (const key of Object.keys(e)) if (!["allowed", "rejectedBy", "deferredBy", "retryAt", "surfaces", "deliverAt", "trace", "shadowed", "nearLimit", "reason_pattern", "commit", "store_after"].includes(key)) fail(file, `${at}.expect unknown key ${key}`);
    if ("ms" in e) fail(file, `${at}.expect must not carry ms`);
    if (e.allowed && (e.rejectedBy || e.deferredBy)) fail(file, `${at}: allowed decisions have no rejectedBy or deferredBy`);
    if (e.rejectedBy && e.deferredBy) fail(file, `${at}: rejectedBy and deferredBy are exclusive`);
    if (e.deferredBy && !e.retryAt) fail(file, `${at}: deferredBy needs retryAt`);
    if ("commit" in e && !t.commit) fail(file, `${at}: expect.commit needs commit: true`);
    for (const key of ["retryAt", "deliverAt"]) if (e[key] && !e[key].endsWith("Z")) fail(file, `${at}.expect.${key} must end in Z`);
  });
  void OUTCOMES;
}

const fixtures = await walk(join(root, "spec/fixtures")).catch(() => []);
for (const file of fixtures) {
  try { checkFixture(file, JSON.parse(await readFile(file, "utf8"))); } catch (error) { fail(file, error.message); }
}
// Every JSON file under examples/ is a policy unless it is an agent hook config (a top-level `hooks` key).
const policies = [];
for (const f of (await readdir(join(root, "examples"))).filter((f) => f.endsWith(".json")).sort()) {
  const file = join(root, "examples", f);
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed && typeof parsed === "object" && "hooks" in parsed && !("checks" in parsed)) continue;
    policies.push(file);
    checkPolicy(file, parsed);
  } catch (error) { fail(file, error.message); }
}
if (failures.length) {
  for (const f of failures) console.error(f);
  process.exit(1);
}
console.log(`ok ${fixtures.length} fixtures, ${policies.length} policies, spec ${specVersion}`);
