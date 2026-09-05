#!/usr/bin/env node
// The release gate, run in CI on every push: the version the package states must be the
// version the CHANGELOG, the citation file, the Action and the plugin manifest state, and
// `npm pack` must ship nothing outside scripts/pack-allowlist.txt.
//
// `--update` rewrites the allowlist from the current pack (review the diff before committing).
// Same file in every Bubblegunn repository. Node built-ins only.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (f) => readFileSync(join(root, f), "utf8");
const has = (f) => existsSync(join(root, f));
const problems = [];

const pkg = JSON.parse(read("package.json"));
const version = pkg.version;

const heading = /^## +(\S+)/m.exec(read("CHANGELOG.md"));
if (!heading) problems.push("CHANGELOG.md has no '## ' heading");
else if (heading[1] !== version) problems.push(`CHANGELOG.md top entry is ${heading[1]}, package.json is ${version}`);

if (has("CITATION.cff")) {
  const v = /^version: "?([^"\n]+)"?$/m.exec(read("CITATION.cff"))?.[1];
  if (v !== version) problems.push(`CITATION.cff version is ${v}, package.json is ${version}`);
}
if (has("action.yml")) {
  const m = /^  version:\n(?:    (?!default:).*\n)*    default: "([^"]*)"/m.exec(read("action.yml"));
  if (m && m[1] !== version) problems.push(`action.yml version input default is ${m[1]}, package.json is ${version}`);
}
if (has("python/pyproject.toml")) {
  const v = /^version = "([^"]*)"$/m.exec(read("python/pyproject.toml"))?.[1];
  if (v !== version) problems.push(`python/pyproject.toml version is ${v}, package.json is ${version}`);
}
if (has(".claude-plugin/plugin.json")) {
  const v = JSON.parse(read(".claude-plugin/plugin.json")).version;
  if (v !== version) problems.push(`.claude-plugin/plugin.json version is ${v}, package.json is ${version}`);
}

const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const files = packed[0].files.map((f) => f.path).sort();
const allowlistPath = "scripts/pack-allowlist.txt";
if (process.argv.includes("--update")) {
  writeFileSync(join(root, allowlistPath), `${files.join("\n")}\n`);
  console.log(`release-gate: wrote ${files.length} paths to ${allowlistPath}`);
  process.exit(0);
}
if (!has(allowlistPath)) problems.push(`${allowlistPath} is missing; run node scripts/release-gate.mjs --update`);
else {
  const allowed = read(allowlistPath)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const ok = (p) => allowed.some((a) => (a.endsWith("/") ? p.startsWith(a) : a === p));
  for (const f of files) if (!ok(f)) problems.push(`npm pack would ship ${f}, which is not in ${allowlistPath}`);
}

if (problems.length) {
  for (const p of problems) console.error(`release-gate: ${p}`);
  process.exit(1);
}
console.log(`release-gate: ok, version ${version} everywhere, ${files.length} packed files all allowed`);
