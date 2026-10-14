#!/usr/bin/env node
// Line and branch coverage of dist/src, measured by Node's own test runner over exactly the files
// `npm test` runs, read from package.json so the two lists cannot drift. Fails below the floors.
//
// The floors are the values measured when this was added on Node 24 with no database or Redis
// configured (92.82% lines, 88.71% branches), rounded down. Node reads the thresholds as whole
// numbers: --test-coverage-lines=58.9 passed a run at 58.83%, so a fraction here would be a floor
// that is not enforced. Raise them when coverage rises; lowering one needs a reason in the commit.
// Run after `npm run build`.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LINES = 92;
const BRANCHES = 88;

const root = join(import.meta.dirname, "..");
const script = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts.test;
const run = /node --test (.+)$/.exec(script)?.[1];
if (!run) {
  console.error("coverage: could not find `node --test <files>` in the npm test script");
  process.exit(1);
}
const files = run.split(/\s+/).filter(Boolean);

const result = spawnSync(
  process.execPath,
  [
    "--test",
    "--experimental-test-coverage",
    "--test-coverage-include=dist/src/**",
    `--test-coverage-lines=${LINES}`,
    `--test-coverage-branches=${BRANCHES}`,
    ...files,
  ],
  { cwd: root, stdio: "inherit" },
);
process.exit(result.status ?? 1);
