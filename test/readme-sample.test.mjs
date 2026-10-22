import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const readme = readFileSync(join(root, "README.md"), "utf8");

// The sample imports "proactive-gate" by name, so it runs in a scratch directory inside the package
// (dist/ is git-ignored), where the bare import resolves through this package's own exports map,
// the way an installed copy resolves it.
test("the first README sample runs as pasted and prints what the README says it prints", () => {
  const section = /## First decision[\s\S]*?```js\n([\s\S]*?)```[\s\S]*?Output:\n\n```\n([\s\S]*?)```/.exec(readme);
  assert.ok(section, "README.md has no '## First decision' section with a js block and an Output block");
  const [, code, expected] = section;
  assert.ok(!/\bredis\b|\blog\.|\bsend\(/.test(code), "the sample uses a name it does not define");
  const base = join(root, "dist", "readme-smoke");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "run-"));
  try {
    writeFileSync(join(dir, "first.mjs"), code);
    const r = spawnSync(process.execPath, ["first.mjs"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trimEnd(), expected.trimEnd());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the sample is the first code block after the recording and the command", () => {
  const firstFence = readme.indexOf("```");
  assert.equal(readme.slice(firstFence, firstFence + 40).startsWith("```\nnpx proactive-gate simulate\n```"), true, "the first code block must be the one command");
});

test("the inbound STOP and START sample runs as pasted and prints what the README says it prints", () => {
  const section = /## Inbound STOP and START[\s\S]*?```js\n([\s\S]*?)```[\s\S]*?Output:\n\n```\n([\s\S]*?)```/.exec(readme);
  assert.ok(section, "README.md has no '## Inbound STOP and START' section with a js block and an Output block");
  const [, code, expected] = section;
  const base = join(root, "dist", "readme-smoke");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "inbound-"));
  try {
    writeFileSync(join(dir, "inbound.mjs"), code);
    const r = spawnSync(process.execPath, ["inbound.mjs"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trimEnd(), expected.trimEnd());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
