#!/usr/bin/env node
// One command releases a version: `npm run release -- 0.2.0` (or patch | minor | major).
//
// It refuses unless the tree is clean, the branch is main and equal to origin/main, the last
// CI run on main passed, and CHANGELOG.md has an unreleased entry for that version. Then it
// dates the entry, sets the version everywhere the repository states it, runs the tests,
// commits, tags, and pushes. The release workflow does the publishing; nothing here talks to
// a registry. `--dry-run` prints the plan and changes nothing.
//
// Same file in every Bubblegunn repository. Node built-ins only.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = process.cwd();
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const spec = args.find((a) => !a.startsWith("--"));

const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
// npm and gh are .cmd shims on Windows, which spawnSync can only start through a shell.
const viaShell = process.platform === "win32";
const sh = (cmd, a, opts = {}) => {
  const r = spawnSync(cmd, a, { cwd: root, stdio: "inherit", shell: viaShell, ...opts });
  if (r.status !== 0) fail(`${cmd} ${a.join(" ")} failed`);
};
const read = (f) => readFileSync(join(root, f), "utf8");
const has = (f) => existsSync(join(root, f));

if (!spec) fail("usage: npm run release -- <X.Y.Z | patch | minor | major> [--dry-run]");

const pkg = JSON.parse(read("package.json"));
const name = pkg.name;
const current = pkg.version;
const target = (() => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!m) fail(`package.json version ${current} is not X.Y.Z`);
  const [, ma, mi, pa] = m.map(Number);
  if (spec === "major") return `${ma + 1}.0.0`;
  if (spec === "minor") return `${ma}.${mi + 1}.0`;
  if (spec === "patch") return `${ma}.${mi}.${pa + 1}`;
  if (!/^\d+\.\d+\.\d+$/.test(spec)) fail(`${spec} is not X.Y.Z, patch, minor or major`);
  return spec;
})();
const tag = `v${target}`;
const cmp = (a, b) => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
if (cmp(target, current) < 0) fail(`${target} is lower than the current version ${current}`);

// Preconditions.
if (git("status", "--porcelain")) fail("the working tree is not clean; commit or stash first");
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "main") fail(`on branch ${branch}; releases are cut from main`);
git("fetch", "origin", "main", "--tags");
const head = git("rev-parse", "HEAD");
if (head !== git("rev-parse", "origin/main")) fail("main is not equal to origin/main; pull or push first");
if (git("tag", "--list", tag)) fail(`tag ${tag} already exists`);
if (process.env.RELEASE_SKIP_CI_CHECK !== "1") {
  const r = spawnSync("gh", ["run", "list", "--branch", "main", "--workflow", "ci", "--limit", "1", "--json", "conclusion,headSha,status"], {
    cwd: root,
    encoding: "utf8",
    shell: viaShell,
  });
  if (r.status !== 0) fail(`gh run list failed (is gh installed and logged in?)\n${r.stderr}`);
  const [run] = JSON.parse(r.stdout || "[]");
  if (!run) fail("no CI run found on main");
  if (run.headSha !== head) fail(`the latest CI run is for ${run.headSha.slice(0, 7)}, not HEAD ${head.slice(0, 7)}; wait for CI`);
  if (run.status !== "completed" || run.conclusion !== "success") fail(`the latest CI run on main is ${run.status} / ${run.conclusion}; releases need a green main`);
}

// The CHANGELOG entry: the first "## " heading must be this version, not yet dated.
const changelog = read("CHANGELOG.md");
const heading = /^## +(\S+)(.*)$/m.exec(changelog);
if (!heading) fail("CHANGELOG.md has no '## ' heading");
const [headingLine, headingVersion, headingRest] = heading;
if (headingVersion !== target) fail(`the top CHANGELOG entry is ${headingVersion}, not ${target}; write the entry first`);
if (/\d{4}-\d{2}-\d{2}/.test(headingRest)) fail(`CHANGELOG entry ${target} is already dated (${headingRest.trim()})`);
const entryBody = changelog.slice(heading.index + headingLine.length).split(/^## /m)[0].trim();
if (!entryBody) fail(`CHANGELOG entry ${target} is empty`);

const today = new Date().toISOString().slice(0, 10);
const plan = [`CHANGELOG.md: "${headingLine}" -> "## ${target} (${today})"`, `package.json: ${current} -> ${target}`];
if (has("package-lock.json")) plan.push(`package-lock.json: ${target}`);
if (has("CITATION.cff")) plan.push(`CITATION.cff: version ${target}, date-released ${today}`);
if (has("action.yml") && /^  version:\n/m.test(read("action.yml"))) plan.push(`action.yml: version input default ${target}`);
if (has("python/pyproject.toml")) plan.push(`python/pyproject.toml: version ${target}`);
if (has(".claude-plugin/plugin.json")) plan.push(`.claude-plugin/plugin.json: version ${target}`);
const readmes = readdirSync(root).filter((f) => /^README(\.[a-zA-Z-]+)?\.md$/.test(f));
const pinned = new RegExp(`Bubblegunn/${name}@v\\d+\\.\\d+\\.\\d+`);
const pinnedAll = new RegExp(pinned.source, "g");
for (const f of readmes) if (pinned.test(read(f))) plan.push(`${f}: Bubblegunn/${name}@${tag}`);
if (pkg.scripts?.["release:prepare"]) plan.push("npm run release:prepare");
const major = `v${target.split(".")[0]}`;
plan.push("npm test", `commit "chore(release): ${target}"`, `tag ${tag} (annotated, message = the CHANGELOG entry)`, "git push origin main --follow-tags", `move ${major} to ${tag} and force-push it (the moving tag Actions users pin)`);

console.log(`release ${name} ${current} -> ${target}${dryRun ? " (dry run)" : ""}`);
for (const p of plan) console.log(`  - ${p}`);
if (dryRun) process.exit(0);

// Apply.
const replaceIn = (f, from, to, label) => {
  const before = read(f);
  // A file already carrying the target value is normal: the repository sets the version
  // when the entry is written. Only a pattern that matches nothing is a mistake.
  const matched = typeof from === "string" ? before.includes(from) : from.test(before);
  if (!matched) fail(`${f}: nothing matched for ${label}`);
  const after = before.replace(from, to);
  if (after !== before) writeFileSync(join(root, f), after);
};
replaceIn("CHANGELOG.md", headingLine, `## ${target} (${today})`, "the entry heading");
sh("npm", ["version", target, "--no-git-tag-version", "--allow-same-version"], { stdio: "ignore" });
if (has("CITATION.cff")) {
  replaceIn("CITATION.cff", /^version: .*$/m, `version: "${target}"`, "version");
  replaceIn("CITATION.cff", /^date-released: .*$/m, `date-released: "${today}"`, "date-released");
}
if (has("action.yml") && /^  version:\n/m.test(read("action.yml"))) {
  replaceIn("action.yml", /(^  version:\n(?:    (?!default:).*\n)*    default: ")[^"]*(")/m, `$1${target}$2`, "the version input default");
}
if (has("python/pyproject.toml")) replaceIn("python/pyproject.toml", /^version = ".*"$/m, `version = "${target}"`, "version");
if (has(".claude-plugin/plugin.json")) replaceIn(".claude-plugin/plugin.json", /"version": "[^"]*"/, `"version": "${target}"`, "version");
for (const f of readmes) {
  const text = read(f);
  if (pinned.test(text)) writeFileSync(join(root, f), text.replace(pinnedAll, `Bubblegunn/${name}@${tag}`));
}
if (pkg.scripts?.["release:prepare"]) sh("npm", ["run", "release:prepare"]);
sh("npm", ["test"]);

const message = [
  `chore(release): ${target}`,
  "",
  `CHANGELOG entry dated ${today}; version set to ${target} in ${plan
    .filter((p) => /^[\w./-]+: /.test(p) && !p.startsWith("CHANGELOG"))
    .map((p) => p.split(":")[0])
    .join(", ")}.`,
  "",
  "For the customer:",
  `What changed: Version ${target} is tagged; the release workflow publishes it with provenance.`,
  `Why it matters: \`npx ${name}@${target}\` installs exactly this commit, and the CHANGELOG says what is in it.`,
  "",
  "Sade dil (teknik olmayan biri için):",
  `- Ne yapıldı: ${target} sürümü etiketlendi; yayın otomatik olarak kayıt defterine çıkar.`,
  "- Ne işe yarar: Kullanıcılar bu sürümü tek komutla kurar ve içinde ne olduğunu CHANGELOG'dan okur.",
  "",
].join("\n");
const dir = mkdtempSync(join(tmpdir(), "release-"));
try {
  writeFileSync(join(dir, "commit.txt"), message);
  writeFileSync(join(dir, "tag.txt"), `${name} ${target}\n\n${entryBody}\n`);
  git("add", "-A");
  sh("git", ["commit", "--quiet", "-F", join(dir, "commit.txt")]);
  sh("git", ["tag", "-a", tag, "-F", join(dir, "tag.txt")]);
  sh("git", ["push", "origin", "main", "--follow-tags"]);
  // The major tag moves from here, not from the workflow: release tags are admin-only by
  // ruleset, and the person running this command is the admin. A workflow token could not.
  sh("git", ["tag", "--force", major, "HEAD"], { stdio: "ignore" });
  sh("git", ["push", "--force", "origin", `refs/tags/${major}`]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const repo = String(pkg.repository?.url ?? pkg.repository ?? "")
  .replace(/^git\+/, "")
  .replace(/\.git$/, "");
console.log(`\n${tag} pushed and ${major} moved to it. Watch the release workflow: ${repo}/actions/workflows/release.yml`);
