import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as api from "../dist/src/index.js";

const root = join(import.meta.dirname, "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const llms = read("llms.txt");
const sentence = read("docs/category-sentence.txt").trim();

// The export names must appear in the API section itself, not anywhere else in the file.
const apiStart = llms.indexOf("\n## API");
const apiSection = llms.slice(apiStart, llms.indexOf("\n## ", apiStart + 1));

test("llms.txt names every value export of the main entry in code spans", () => {
  const names = Object.keys(api);
  assert.ok(apiStart >= 0, "llms.txt has no API section");
  assert.ok(names.length >= 20, "the export list looks empty");
  const missing = names.filter((n) => !apiSection.includes(`\`${n}\``));
  assert.deepEqual(missing, [], `value exports missing from llms.txt: ${missing.join(", ")}`);
});

test("llms.txt names every CLI command in the HELP text", () => {
  const help = /const HELP = `([\s\S]*?)`;/.exec(read("src/cli.ts"));
  assert.ok(help, "could not find HELP in src/cli.ts");
  const cmds = [...new Set([...help[1].matchAll(/^\s*(?:usage: )?proactive-gate (\w+)/gm)].map((m) => m[1]))];
  assert.ok(cmds.length >= 6, `the HELP scan found only ${cmds.length} commands`);
  const missing = cmds.filter((c) => !llms.includes(`\`proactive-gate ${c}\``));
  assert.deepEqual(missing, [], `commands missing from llms.txt: ${missing.join(", ")}`);
});

test("llms.txt names the other stores and the Go and Python implementations", () => {
  for (const term of ["PostgresStore", "AsyncSqliteStore", "AsyncMemoryStore", "Go", "Python", "pip install proactive-gate", "go get github.com/Bubblegunn/proactive-gate/go"]) {
    assert.ok(llms.includes(term), `llms.txt lacks ${term}`);
  }
});

test("llms.txt opens with the category sentence", () => {
  assert.ok(llms.split("\n").slice(0, 6).join("\n").includes(sentence));
});

test("every doc link in llms.txt points at a file that exists", () => {
  for (const m of llms.matchAll(/\]\((?!https?:)([^)#]+)\)/g)) {
    assert.doesNotThrow(() => readFileSync(join(root, m[1]), "utf8").length || readFileSync(join(root, m[1])), `broken link: ${m[1]}`);
  }
});

test("llms.txt gives the npx skills route next to the npm, pip and go lines and the plugin line", () => {
  for (const line of ["npm install proactive-gate", "pip install proactive-gate", "npx skills add Bubblegunn/proactive-gate", "/plugin install proactive-gate --marketplace Bubblegunn/proactive-gate"]) {
    assert.ok(llms.includes(line), `llms.txt lacks ${line}`);
  }
  assert.ok(llms.includes("whenAllowed"), "llms.txt does not name gate.whenAllowed");
});
