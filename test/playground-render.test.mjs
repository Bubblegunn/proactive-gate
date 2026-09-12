/**
 * The playground renders trace reasons, and a reason carries text that came from the editable
 * Input JSON on the page. These tests hold that render path to text rather than markup.
 *
 * They import the exact file the browser imports, docs/site/public/playground/trace-table.mjs,
 * so there is no build step between what is tested and what is served.
 *
 * There is no jsdom here and no new dependency: the module takes its document as an argument,
 * so a stand-in of about thirty lines is enough, and the stand-in is the assertion. It has no
 * HTML parser at all. If the module ever assigns `innerHTML` again, the text it assigns has
 * nowhere to become an element, and the "no HTML sink" test fails outright.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GLYPH, renderScenarioButtons, renderTraceTable, rowClasses } from "../docs/site/public/playground/trace-table.mjs";

const MODULE = fileURLToPath(new URL("../docs/site/public/playground/trace-table.mjs", import.meta.url));
const PAGE = fileURLToPath(new URL("../docs/site/src/pages/playground.astro", import.meta.url));

/** A document with no HTML parser. Nodes hold text as text or not at all. */
function fakeDocument() {
  const created = [];
  const make = (tag) => {
    const node = {
      tag,
      className: "",
      textContent: "",
      attributes: {},
      children: [],
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      replaceChildren(...next) {
        this.children = next;
      },
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
    };
    created.push(node);
    return node;
  };
  return { createElement: make, created, root: make("tbody") };
}

/** Every string this subtree carries, so a payload cannot hide in a nested node. */
const allText = (node) => [node.textContent, ...node.children.flatMap(allText)].filter(Boolean);
const flatten = (node) => [node, ...node.children.flatMap(flatten)];

const entry = (overrides = {}) => ({ id: "quietHours", outcome: "reject", ms: 0.08, ...overrides });

test("a reason carrying HTML is rendered as text, not as markup", () => {
  // The shape a caller can actually reach: quietHours builds its reason from user.timezone,
  // which is typed into the Input textarea on the page.
  const payload = '<img src=x onerror="alert(1)">';
  const reason = `quiet hours 22:00 to 08:00 ${payload}; priority normal is below the floor (high)`;
  const doc = fakeDocument();

  renderTraceTable(doc.root, [entry({ reason })], "quietHours", doc);

  const reasonCell = flatten(doc.root).find((n) => n.className === "rs");
  assert.equal(reasonCell.textContent, reason, "the reason is one text value, payload included");
  assert.equal(reasonCell.children.length, 0, "and it produced no child nodes");
  assert.equal(
    doc.created.filter((n) => n.tag === "img").length,
    0,
    "nothing in the payload became an element",
  );
});

test("a quote in a reason cannot break out into an attribute", () => {
  // The previous version interpolated into class="..." and into cell text in the same string,
  // so a quote in either place could close an attribute early.
  const payload = '" onmouseover="alert(1)" data-x="';
  const doc = fakeDocument();

  renderTraceTable(doc.root, [entry({ reason: payload, id: payload })], "quietHours", doc);

  for (const node of flatten(doc.root)) {
    assert.equal(node.attributes.onmouseover, undefined, "no event-handler attribute appeared");
    assert.ok(!/onmouseover/.test(node.className), "and none leaked into a class either");
  }
  const texts = allText(doc.root);
  assert.ok(texts.includes(payload), "the payload is still shown to the reader, as text");
});

test("scenario labels are rendered as text too", () => {
  const doc = fakeDocument();
  const scenarios = [{ key: "ok", label: "<b>09:00</b>, ordinary day", note: "<i>nothing</i> in the way" }];

  renderScenarioButtons(doc.root, scenarios, doc);

  assert.equal(doc.created.filter((n) => n.tag === "b" || n.tag === "i").length, 0);
  const texts = allText(doc.root);
  assert.ok(texts.includes("<b>09:00</b>, ordinary day"));
  assert.ok(texts.includes("<i>nothing</i> in the way"));
  assert.equal(doc.root.children[0].attributes["data-key"], "ok");
  assert.equal(doc.root.children[0].attributes.type, "button");
});

test("neither the render module nor the page reaches for an HTML sink", () => {
  const sinks = /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/;
  for (const [name, path] of [["the render module", MODULE], ["the playground page", PAGE]]) {
    const source = readFileSync(path, "utf8");
    const offenders = source
      .split("\n")
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => sinks.test(line) && !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"));
    assert.deepEqual(offenders, [], `${name} assigns an HTML sink at ${offenders.map(([n]) => n).join(", ")}`);
  }
});

test("the page loads the module the browser is served, by the path it is served at", () => {
  const source = readFileSync(PAGE, "utf8");
  assert.match(source, /playground\/trace-table\.mjs/, "the page imports the module under test");
  assert.match(source, /renderTraceTable\(/);
  assert.match(source, /renderScenarioButtons\(/);
});

test("the row class marks the stopping check, and shadow rows stay dim", () => {
  assert.equal(rowClasses(entry({ id: "quietHours" }), "quietHours"), "stop");
  assert.equal(rowClasses(entry({ id: "consent", outcome: "pass" }), "quietHours"), "o-pass");
  assert.equal(rowClasses(entry({ id: "utilityFloor", shadow: true }), "quietHours"), "o-reject shadow");
  // A shadow check never stops the message, so it must never be the filled row.
  assert.equal(rowClasses(entry({ id: "utilityFloor", shadow: true }), "utilityFloor"), "stop shadow");
});

test("every outcome kind the spec allows has a glyph", () => {
  // spec/SPEC.md 3.1: pass, reject, adjust, skip, defer.
  const doc = fakeDocument();
  const trace = ["pass", "reject", "adjust", "skip", "defer"].map((outcome) => entry({ outcome }));
  renderTraceTable(doc.root, trace, "none", doc);
  const glyphs = flatten(doc.root).filter((n) => n.className === "g").map((n) => n.textContent);
  assert.equal(glyphs.length, 5);
  assert.deepEqual(glyphs.slice(0, 2), [GLYPH.pass, GLYPH.reject]);
  assert.ok(glyphs.every(Boolean), "no outcome renders an empty glyph");
});
