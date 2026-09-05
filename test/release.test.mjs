// scripts/release.mjs against a throwaway repository with a local bare origin. No network:
// RELEASE_SKIP_CI_CHECK=1 stands in for the gh run check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "release.mjs");

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "release-test-"));
  const origin = join(base, "origin.git");
  const repo = join(base, "repo");
  execFileSync("git", ["init", "--bare", "--quiet", "-b", "main", origin]);
  mkdirSync(repo);
  const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "--quiet", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  const write = (f, s) => {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    writeFileSync(join(repo, f), s);
  };
  write(
    "package.json",
    `${JSON.stringify(
      {
        name: "fixture-pkg",
        version: "0.1.0",
        scripts: { test: "node -e 0" },
        repository: { type: "git", url: "git+https://github.com/Bubblegunn/fixture-pkg.git" },
      },
      null,
      2,
    )}\n`,
  );
  write("CHANGELOG.md", "# Changelog\n\n## 0.2.0 (unreleased)\n\n- Something new.\n- And a fix.\n\n## 0.1.0 (2026-01-01)\n\n- First.\n");
  write("CITATION.cff", 'cff-version: 1.2.0\ntitle: "fixture-pkg"\nversion: "0.1.0"\ndate-released: "2026-01-01"\n');
  write("action.yml", 'name: fixture\ninputs:\n  mode:\n    default: "x"\n  version:\n    description: fixture version to run.\n    required: false\n    default: "0.1.0"\nruns:\n  using: composite\n  steps: []\n');
  write("README.md", "# fixture\n\n- uses: Bubblegunn/fixture-pkg@v0.1.0\n- uses: Bubblegunn/fixture-pkg@v0\n");
  write(".claude-plugin/plugin.json", '{\n  "name": "fixture-pkg",\n  "version": "0.1.0",\n  "keywords": ["a", "b"]\n}\n');
  write("python/pyproject.toml", '[project]\nname = "fixture-pkg"\nversion = "0.1.0"\n');
  git("add", "-A");
  git("commit", "--quiet", "-m", "init");
  git("remote", "add", "origin", origin);
  git("push", "--quiet", "-u", "origin", "main");
  return { base, origin, repo, git, read: (f) => readFileSync(join(repo, f), "utf8") };
}

const run = (repo, ...args) =>
  spawnSync(process.execPath, [script, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, RELEASE_SKIP_CI_CHECK: "1" },
  });

test("dry run prints the plan and changes nothing", () => {
  const f = fixture();
  try {
    const r = run(f.repo, "0.2.0", "--dry-run");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /release fixture-pkg 0\.1\.0 -> 0\.2\.0 \(dry run\)/);
    assert.match(r.stdout, /CITATION\.cff: version 0\.2\.0/);
    assert.match(r.stdout, /action\.yml: version input default 0\.2\.0/);
    assert.match(r.stdout, /README\.md: Bubblegunn\/fixture-pkg@v0\.2\.0/);
    assert.match(r.stdout, /move v0 to v0\.2\.0 and force-push it/);
    assert.equal(f.git("status", "--porcelain"), "");
    assert.equal(f.read("package.json").includes('"0.1.0"'), true);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("a release dates the entry, bumps every version, commits, tags and pushes", () => {
  const f = fixture();
  try {
    const r = run(f.repo, "minor");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const today = new Date().toISOString().slice(0, 10);
    assert.match(f.read("CHANGELOG.md"), new RegExp(`^## 0\\.2\\.0 \\(${today}\\)$`, "m"));
    assert.equal(JSON.parse(f.read("package.json")).version, "0.2.0");
    assert.match(f.read("CITATION.cff"), /^version: "0\.2\.0"$/m);
    assert.match(f.read("CITATION.cff"), new RegExp(`^date-released: "${today}"$`, "m"));
    assert.match(f.read("action.yml"), /  version:\n    description: fixture version to run\.\n    required: false\n    default: "0\.2\.0"/);
    assert.match(f.read("action.yml"), /mode:\n    default: "x"/);
    assert.match(f.read("README.md"), /fixture-pkg@v0\.2\.0/);
    assert.match(f.read("README.md"), /fixture-pkg@v0\n/);
    assert.equal(JSON.parse(f.read(".claude-plugin/plugin.json")).version, "0.2.0");
    assert.match(f.read("python/pyproject.toml"), /^version = "0\.2\.0"$/m);
    assert.equal(f.git("status", "--porcelain"), "");
    assert.equal(f.git("log", "-1", "--format=%s"), "chore(release): 0.2.0");
    assert.match(f.git("log", "-1", "--format=%b"), /For the customer:/);
    assert.equal(f.git("rev-parse", "HEAD"), f.git("rev-parse", "origin/main"));
    const originTags = execFileSync("git", ["tag", "--list"], { cwd: f.origin, encoding: "utf8" }).trim().split("\n").sort();
    assert.deepEqual(originTags, ["v0", "v0.2.0"]);
    const originRev = (ref) => execFileSync("git", ["rev-parse", `${ref}^{commit}`], { cwd: f.origin, encoding: "utf8" }).trim();
    assert.equal(originRev("v0"), f.git("rev-parse", "HEAD"), "the major tag on origin points at the release commit");
    assert.equal(originRev("v0"), originRev("v0.2.0"));
    assert.match(f.git("tag", "-l", "-n99", "v0.2.0"), /Something new/);
    assert.match(r.stdout, /v0\.2\.0 pushed and v0 moved to it\. Watch the release workflow: https:\/\/github\.com\/Bubblegunn\/fixture-pkg\/actions\/workflows\/release\.yml/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("refuses a dirty tree, a version the CHANGELOG does not name, and a lower version", () => {
  const f = fixture();
  try {
    let r = run(f.repo, "0.3.0");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /top CHANGELOG entry is 0\.2\.0, not 0\.3\.0/);
    r = run(f.repo, "0.0.9");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /lower than the current version/);
    writeFileSync(join(f.repo, "scratch.txt"), "x");
    r = run(f.repo, "0.2.0");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not clean/);
    assert.equal(f.read("package.json").includes('"0.1.0"'), true);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("a file already carrying the target version is not a failure", () => {
  // Every repository writes the version into package.json and CITATION.cff when the
  // changelog entry is written, so the release finds them already correct. Treating an
  // unchanged file as "nothing matched" aborted the release after the changelog was
  // already dated, which is how the first real release of this package failed.
  const f = fixture();
  const already = 'cff-version: 1.2.0\ntitle: "fixture-pkg"\nversion: "0.2.0"\ndate-released: "2026-01-01"\n';
  writeFileSync(join(f.repo, "CITATION.cff"), already);
  writeFileSync(join(f.repo, ".claude-plugin", "plugin.json"), '{\n  "name": "fixture-pkg",\n  "version": "0.2.0",\n  "keywords": ["a", "b"]\n}\n');
  f.git("commit", "--quiet", "-am", "versions already at the target");
  f.git("push", "--quiet", "origin", "main");

  const r = run(f.repo, "0.2.0");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(f.read("CITATION.cff"), /^version: "0\.2\.0"$/m);
  assert.match(f.read("CITATION.cff"), new RegExp(`^date-released: "${new Date().toISOString().slice(0, 10)}"$`, "m"));
  assert.match(f.read("CHANGELOG.md"), /^## 0\.2\.0 \(\d{4}-\d{2}-\d{2}\)$/m);
  assert.equal(execFileSync("git", ["tag", "--list"], { cwd: f.repo, encoding: "utf8" }).trim().split("\n").sort().join(","), "v0,v0.2.0");
});

test("a pattern that truly matches nothing still fails", () => {
  const f = fixture();
  writeFileSync(join(f.repo, "CITATION.cff"), 'cff-version: 1.2.0\ntitle: "fixture-pkg"\n');
  f.git("commit", "--quiet", "-am", "citation without a version line");
  f.git("push", "--quiet", "origin", "main");

  const r = run(f.repo, "0.2.0");
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /CITATION\.cff: nothing matched for version/);
});
