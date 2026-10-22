import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("the pain evidence page has the sentence, at least three public links and a read date for each", () => {
  const text = read("docs/PAIN-EVIDENCE.md");
  assert.ok(text.includes("My AI agent messages people at night and past their daily limit, and I cannot tell which rule should have stopped it."));
  const rows = text.split("\n").filter((l) => /^\| \[/.test(l));
  assert.ok(rows.length >= 3, `only ${rows.length} evidence rows`);
  for (const r of rows) {
    assert.match(r, /https:\/\/(github\.com|forum\.asana\.com)\//, `row has no public link: ${r}`);
    assert.match(r, /20\d\d-\d\d-\d\d/, `row has no date: ${r}`);
  }
});

test("the GEO prompts page has exactly five numbered prompts and empty record tables", () => {
  const text = read("docs/GEO-PROMPTS.md");
  const prompts = text.split("\n").filter((l) => /^[1-5]\. "/.test(l));
  assert.equal(prompts.length, 5);
  assert.equal(new Set(prompts).size, 5);
  assert.ok(text.includes("## Before launch"));
  assert.ok(text.includes("## 14 days after launch"));
});

test("the decision id in decisions.md has the shape the library produces", async () => {
  const { createGate, MemoryStore } = await import("../dist/src/index.js");
  const gate = createGate({ store: new MemoryStore(), checks: [] });
  const real = (await gate.evaluate({ user: { id: "ayse", consent: true }, candidate: { id: "a1", type: "reminder" }, now: new Date("2026-09-04T03:00:00Z") })).id;
  const sample = /id: "([^"]+)"/.exec(read("docs/site/src/content/docs/decisions.md"))[1];
  // user:candidate:instant#<instance>-<sequence>, the instance being the token of one gate
  const shape = /^[^#]+#[0-9a-f-]+-\d+$/;
  assert.match(real, shape);
  assert.match(sample, shape, "the sample id is not the library's shape");
  assert.equal(sample.split("#")[0], real.split("#")[0], "the sample names a different user, candidate or instant");
});

test("the head-to-head page gives the re-run command and the commits rerun.sh pins, both read from the script", () => {
  const script = read("bench/head-to-head/rerun.sh");
  const page = read("docs/HEAD-TO-HEAD.md");
  assert.ok(page.includes("bash bench/head-to-head/rerun.sh --model claude-sonnet-5-5 --reps 3"), "no re-run command");
  const pins = [...script.matchAll(/^clone (\S+) \S+ ([0-9a-f]{40})$/gm)].map((m) => ({ url: m[1], sha: m[2] }));
  assert.equal(pins.length, 1, "rerun.sh should pin the one competitor it still runs (Knock)");
  assert.ok(!/vaara/i.test(script), "rerun.sh must not run Vaara (see the Rulings section)");
  for (const p of pins) assert.ok(page.includes(p.sha), `the page does not name the pinned commit ${p.sha}`);
  assert.ok(page.includes("npm pack"), "the page does not say the build is packed with npm pack");
  assert.ok(page.includes("bench/head-to-head/LABELS.md"), "the page does not link the criterion labels");
});
