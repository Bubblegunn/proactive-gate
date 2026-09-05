import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadFixtures, readSkips, runFixture } from "../src/conformance.js";

const root = new URL("../../", import.meta.url).pathname; // dist/test -> repo root
const fixtures = await loadFixtures(`${root}spec/fixtures`);
const skips = await readSkips(`${root}spec/skip/ts.txt`);
const specVersion = (await readFile(`${root}spec/SPEC_VERSION`, "utf8")).trim();

test("there are fixtures and they target the current spec version", () => {
  assert.ok(fixtures.length >= 10, `only ${fixtures.length} fixtures`);
  for (const f of fixtures) assert.equal(f.spec_version, specVersion, f.name);
});

for (const fixture of fixtures) {
  test(`conformance: ${fixture.name}`, { skip: skips.get(fixture.name) }, async () => {
    const failures = await runFixture(fixture);
    assert.deepEqual(failures, []);
  });
}
