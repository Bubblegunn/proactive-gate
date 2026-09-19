// The replay page runs the simulator in the browser. The simulator is not part of
// the package entry, and must not become part of it: a second esbuild entry point
// is what keeps `npm pack` where it is. These tests hold both halves of that, and
// check the browser artifact against the library rather than trusting that a
// bundler round trip preserves behaviour.
//
// No browser is launched. What is exercised is the built ESM the page imports.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const site = `${root}docs/site`;
const bundleDir = `${site}/public/playground`;

const built = (() => {
  if (!existsSync(`${site}/node_modules/esbuild`)) return false;
  execFileSync(process.execPath, ["scripts/bundle.mjs"], { cwd: site, stdio: "ignore" });
  return true;
})();

const needsBundle = { skip: built ? false : "docs/site dependencies are not installed; run npm ci there" };

test("the simulator reaches the browser without joining the package entry", needsBundle, async () => {
  const sim = await import(`${bundleDir}/sim.js`);
  const demo = await import(`${bundleDir}/demo.js`);
  assert.equal(typeof sim.simulate, "function", "the replay page has nothing to run without this");
  assert.equal(typeof demo.demoWeek, "function");

  // The guard the second entry point exists for. If `simulate` ever appears in the
  // package entry it ships to every consumer of the library, and the pack allowlist
  // will not notice, because the file was already allowed.
  const entry = readFileSync(`${root}src/index.ts`, "utf8");
  assert.doesNotMatch(entry, /\bsimulate\b/, "src/index.ts must not export the simulator");
  const gate = readFileSync(`${bundleDir}/gate.js`, "utf8");
  assert.ok(!gate.includes("simulate"), "the package bundle must not carry the simulator either");
});

test("the browser artifact and the library agree about the same week", needsBundle, async () => {
  const sim = await import(`${bundleDir}/sim.js`);
  const demo = await import(`${bundleDir}/demo.js`);
  const lib = await import(`${root}dist/src/simulate.js`);
  const libDemo = await import(`${root}dist/src/demo-week.js`);

  const policies = [
    { label: "A", policy: JSON.parse(readFileSync(`${root}examples/policies/aggressive.json`, "utf8")) },
    { label: "B", policy: JSON.parse(readFileSync(`${root}examples/policies/respectful.json`, "utf8")) },
  ];
  const opts = { policies, seed: 7, stream: "synthetic" };

  const fromBrowser = await sim.simulate({ events: demo.demoWeek(7), ...opts });
  const fromLibrary = await lib.simulate({ events: libDemo.demoWeek(7), ...opts });

  assert.equal(fromBrowser.events, fromLibrary.events);
  assert.equal(fromBrowser.disagreements.length, fromLibrary.disagreements.length);
  assert.deepEqual(fromBrowser.differenceCounts, fromLibrary.differenceCounts);
  assert.deepEqual(
    fromBrowser.runs.map((r) => r.counts),
    fromLibrary.runs.map((r) => r.counts),
    "every figure the page prints comes from these counts",
  );
  // Not a vacuous pass: the comparison has to have found something to compare.
  assert.ok(fromBrowser.disagreements.length > 0, "two policies that never disagree would prove nothing");
});

test("the page's two policies are the files the command line reads, not copies", () => {
  const page = readFileSync(`${root}docs/site/src/pages/replay.astro`, "utf8");
  assert.match(page, /examples\/policies\/aggressive\.json\?raw/);
  assert.match(page, /examples\/policies\/respectful\.json\?raw/);
  // A literal policy in the page would drift the moment either file changed.
  assert.doesNotMatch(page, /"specVersion"/, "the policy text must not be pasted into the page");
});
