import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const readme = read("README.md");
const comparison = read("docs/COMPARISON.md");

// "| comparison | against | ours wins | ties | ours loses | both wrong |" rows of the Summary table.
const summary = [...comparison.split("## Summary")[1].matchAll(/^\| (.+?) \| (.+?) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \|$/gm)].map((m) => ({
  what: m[1], against: m[2], wins: +m[3], ties: +m[4], loses: +m[5], bothWrong: +m[6],
}));
const row = (what, against) => {
  const r = summary.find((s) => s.what.startsWith(what) && s.against === against);
  assert.ok(r, `COMPARISON.md has no summary row for ${what} / ${against}`);
  return { ...r, total: r.wins + r.ties + r.loses + r.bothWrong, ours: r.wins + r.ties, theirs: r.ties + r.loses };
};
const section = (text, heading) => {
  const i = text.indexOf(heading);
  assert.ok(i >= 0, `missing section ${heading}`);
  return text.slice(i).split(/\n## /)[0];
};
const differs = section(readme, "## How this differs from Cue, notifkit and tcpa-quiet-hours");

// The comparison table, one array of trimmed cells per body row, keyed by the first cell (the label).
const tableLines = differs.split("\n").filter((l) => l.startsWith("|"));
const header = tableLines[0].split("|").slice(1, -1).map((c) => c.trim());
const cellsOf = (line) => line.split("|").slice(1, -1).map((c) => c.trim());
const body = new Map(tableLines.slice(2).map((l) => [cellsOf(l)[0], cellsOf(l)]));
const cell = (label, column) => {
  const cells = body.get(label);
  assert.ok(cells, `the README table has no row "${label}"`);
  const i = header.findIndex((h) => h.startsWith(column));
  assert.ok(i > 0, `the README table has no column "${column}"`);
  return cells[i];
};
const countCell = (r, n) => `${n} of ${r.total}`;

test("the comparison table has the three columns and the rows COMPARISON.md computed", () => {
  assert.deepEqual(header.slice(0, 1), ["same inputs"]);
  assert.ok(header.some((h) => h.startsWith("proactive-gate")));
  assert.ok(header.some((h) => h.startsWith("Cue")));
  assert.ok(header.some((h) => h.startsWith("notifkit")));
  assert.ok(header.some((h) => h.startsWith("tcpa-quiet-hours")));
  assert.equal(body.size, 3);
});

// The versions COMPARISON.md pins for each tool, keyed by the name in its first column (links unwrapped).
const pinnedRows = comparison.split("## Pinned versions")[1].split("\n## ")[0].split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| tool ") && !l.startsWith("|---"));
const pinned = new Map(pinnedRows.map((l) => {
  const cells = l.split("|").slice(1, -1).map((c) => c.trim());
  return [cells[0].replace(/^\[(.+?)\]\(.+?\)$/, "$1"), cells[1]];
}));

test("the table header names each other tool at the version COMPARISON.md pins", () => {
  for (const tool of ["Cue", "notifkit", "tcpa-quiet-hours"]) {
    const version = pinned.get(tool);
    assert.ok(version, `COMPARISON.md pins no version for ${tool}`);
    const h = header.find((x) => x.startsWith(tool));
    assert.ok(h, `the README table has no ${tool} column`);
    assert.ok(h.includes(` ${version}`), `the ${tool} column reads "${h}", not ${version}`);
  }
});

test("the quiet-hours rows state each tool's count per cell", () => {
  const instant = "Quiet hours: is this instant quiet?";
  const next = "Quiet hours: when may the message go?";
  const a = row(instant, "Cue");
  const b = row(instant, "notifkit");
  assert.equal(cell(instant, "proactive-gate"), countCell(a, a.ours));
  assert.equal(cell(instant, "Cue"), countCell(a, a.theirs));
  assert.equal(cell(instant, "notifkit"), countCell(b, b.theirs));
  assert.equal(cell(instant, "tcpa-quiet-hours"), "not run");

  const c = row(next, "Cue");
  const d = row(next, "notifkit");
  assert.equal(cell(next, "proactive-gate"), countCell(c, c.ours));
  assert.equal(cell(next, "Cue"), countCell(c, c.theirs));
  assert.equal(cell(next, "notifkit"), countCell(d, d.theirs));
  assert.equal(cell(next, "tcpa-quiet-hours"), "not run");
});

test("the TCPA row states the same-answer count, the state-row note and the reference cells", () => {
  const label = "US calling hours (TCPA)";
  const t = row(label, "tcpa-quiet-hours");
  assert.equal(
    cell(label, "proactive-gate"),
    `${t.ties} of ${t.total} cases give the same answer (${t.loses} state rows have no independent answer)`,
  );
  assert.equal(cell(label, "Cue"), "not run");
  assert.equal(cell(label, "notifkit"), "not run");
  assert.equal(cell(label, "tcpa-quiet-hours"), "reference");
});

test("the README names the three state-rule losses in prose", () => {
  const t = row("US calling hours (TCPA)", "tcpa-quiet-hours");
  assert.ok(differs.includes(`${t.loses} state-rule cases`), "README lacks the TCPA loss count");
});

test("the daylight-saving example quotes the two answers COMPARISON.md printed", () => {
  const line = comparison.split("\n").find((l) => l.startsWith("| spring-forward-end-in-the-gap | 2026-03-08"));
  assert.ok(line, "no spring-forward-end-in-the-gap row in the next-time table");
  const cells = line.split("|").map((c) => c.trim());
  const ours = /(\d\d:\d\dZ)/.exec(cells[3])[1];
  const theirs = /(\d\d:\d\dZ)/.exec(cells[4])[1];
  assert.notEqual(ours, theirs);
  assert.ok(differs.includes(`\`${ours}\``) && differs.includes(`\`${theirs}\``), "README does not quote both times");
  assert.ok(differs.includes("answer later than proactive-gate"), "README does not say Cue and notifkit answer later");
});

test("the comparison links the file and states the losses", () => {
  assert.ok(differs.includes("(docs/COMPARISON.md)"));
  assert.ok(/does not send messages/.test(differs));
  assert.ok(/digest/.test(differs) && /approv/.test(differs));
});

test("no claim about a tool is made for a row ours loses", () => {
  // The README may say "better", "faster" or "more accurate" only about rows ours wins; today it says none of them.
  assert.ok(!/\b(better than|more accurate than|beats|outperforms)\b/i.test(differs));
});

const page = (slug) => read(`docs/site/src/content/docs/${slug}.md`);

test("each vs page states the counts COMPARISON.md computed for that tool", () => {
  for (const [slug, tool] of [["vs-cue", "Cue"], ["vs-notifkit", "notifkit"]]) {
    const text = page(slug);
    const quiet = row("Quiet hours: is this instant quiet?", tool);
    const next = row("Quiet hours: when may the message go?", tool);
    assert.ok(text.includes(`${quiet.ours} of ${quiet.total}`), `${slug} lacks ${quiet.ours} of ${quiet.total}`);
    assert.ok(text.includes(`${next.ours} of ${next.total}`) && text.includes(`${next.theirs} of ${next.total}`), `${slug} lacks the next-time counts`);
    assert.ok(text.includes("docs/COMPARISON.md"));
  }
  const tcpa = row("US calling hours (TCPA)", "tcpa-quiet-hours");
  const t = page("vs-tcpa-quiet-hours");
  assert.ok(t.includes(`${tcpa.ties} of ${tcpa.total}`) && t.includes(`${tcpa.loses} state-rule cases`));
});

test("the hosted-platforms page states that nothing was measured and carries no comparison numbers", () => {
  const t = page("vs-novu-knock-courier");
  assert.ok(t.includes("not measured"));
  assert.ok(!/\b\d+ of \d+\b/.test(t), "a count appears on a page whose rows were never run");
});

test("every vs page and the FAQ have a title and a description in the front matter", () => {
  for (const slug of ["vs-cue", "vs-notifkit", "vs-tcpa-quiet-hours", "vs-novu-knock-courier", "faq"]) {
    const front = /^---\ntitle: (.+)\ndescription: (.+)\n---\n/.exec(page(slug));
    assert.ok(front, `${slug} lacks title and description front matter`);
    assert.ok(front[2].length > 40 && front[2].length < 200, `${slug} description length`);
  }
});

test("the FAQ is question and answer: at least ten questions as headings, each followed by an answer", () => {
  const qs = [...page("faq").matchAll(/^## (.+\?)\n\n(.+)/gm)];
  assert.ok(qs.length >= 10, `only ${qs.length} questions`);
  for (const q of qs) assert.ok(q[2].length > 40, `answer too short for: ${q[1]}`);
});

test("start.md carries the same runnable sample as the README", () => {
  const sample = (text) => /```js\n([\s\S]*?)```/.exec(text)[1];
  assert.equal(sample(read("docs/site/src/content/docs/start.md")), sample(section(readme, "## First decision")));
});

test("the README offers the three install routes, npm, the plugin and npx skills, in that order, before the Python and Go lines", () => {
  const routes = ["npm install proactive-gate", "/plugin install proactive-gate --marketplace Bubblegunn/proactive-gate", "npx skills add Bubblegunn/proactive-gate"];
  for (const text of [readme, read("README.tr.md")]) {
    const at = routes.map((r) => text.indexOf(`\n${r}\n`));
    for (const [i, p] of at.entries()) assert.ok(p > 0, `no code block with ${routes[i]}`);
    assert.deepEqual([...at].sort((a, b) => a - b), at, "the three routes are not in the order npm, plugin, skills");
    const pip = text.indexOf("pip install proactive-gate");
    assert.ok(pip > at[2], "the Python line does not follow the three routes");
  }
});

test("the README has the head-to-head section, which links the page and carries no result numbers", () => {
  const section_ = section(readme, "## Head to head");
  assert.ok(section_.includes("Results: see docs/HEAD-TO-HEAD.md"));
  assert.ok(section_.includes("(docs/HEAD-TO-HEAD.md)"));
  assert.ok(!/\d/.test(section_), "the section carries a digit; results belong in docs/HEAD-TO-HEAD.md");
});

test("the Turkish README has the same install routes and the same head-to-head link", () => {
  const tr = read("README.tr.md");
  assert.ok(tr.includes("npx skills add Bubblegunn/proactive-gate"));
  assert.ok(tr.includes("(docs/HEAD-TO-HEAD.md)"));
});

test("both READMEs name the one-command init that the skill guide opens with, in code", () => {
  const command = /npx proactive-gate init --minimal --legal [a-z]+/.exec(read("skills/proactive-gate/references/guide.md"))?.[0];
  assert.ok(command, "the guide names the one-command init");
  for (const text of [readme, read("README.tr.md")]) assert.ok(text.includes(`\`${command}\``), `a README lacks \`${command}\``);
});
