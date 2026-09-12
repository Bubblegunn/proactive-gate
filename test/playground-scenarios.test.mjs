/**
 * The playground's nine scenarios, re-derived from real library runs.
 *
 * The page states a verdict in each scenario's label. These tests run the page's own scenario
 * data through the real package and check the stated verdict against the decision the library
 * actually returns, so no verdict on that page is a transcribed string. The file the browser
 * loads is the file imported here.
 *
 * They also hold the scope split in place: the default demo carries no legal instrument, and
 * the one scenario that does carries its scope and a checked date.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as lib from "proactive-gate";
import {
  COMMERCIAL_SCOPE,
  POLICIES,
  SCOPE_CHECKED,
  evaluateWithPrespend,
  inputFor,
  outcomeOf,
  policyFor,
  preferencePolicy,
  scenarios,
} from "../docs/site/public/playground/scenarios.mjs";

const PAGE = fileURLToPath(new URL("../docs/site/src/pages/playground.astro", import.meta.url));

const run = (scenario) => evaluateWithPrespend(lib, policyFor(scenario), inputFor(scenario));

test("all nine scenarios are present and uniquely keyed", () => {
  assert.equal(scenarios.length, 9);
  assert.equal(new Set(scenarios.map((s) => s.key)).size, 9);
  for (const s of scenarios) {
    assert.ok(s.label && s.note, `${s.key} has a label and a note`);
    assert.ok(POLICIES[s.policy], `${s.key} names a policy that exists`);
    assert.ok(s.expect?.outcome, `${s.key} states the verdict its label implies`);
  }
});

test("every scenario's stated verdict is the verdict the library returns", async () => {
  for (const scenario of scenarios) {
    const decision = await run(scenario);
    const actual = outcomeOf(decision);
    assert.equal(actual, scenario.expect.outcome, `${scenario.key}: label says ${scenario.expect.outcome}, library says ${actual} (${decision.reason ?? "no reason"})`);
    if (scenario.expect.by) {
      const by = decision.rejectedBy ?? decision.deferredBy;
      assert.equal(by, scenario.expect.by, `${scenario.key}: stopped by ${by}, label says ${scenario.expect.by}`);
    }
    if (scenario.expect.surfaces) {
      assert.deepEqual(decision.surfaces, scenario.expect.surfaces, `${scenario.key}: surfaces`);
    }
  }
});

test("a stated verdict cannot silently stop matching the library", async () => {
  // The guard above only bites if a wrong claim fails, so here is a wrong claim.
  const quiet = scenarios.find((s) => s.key === "quiet");
  const decision = await run(quiet);
  assert.notEqual(outcomeOf(decision), "allowed");
  assert.notEqual(decision.rejectedBy, "dailyBudget");
});

test("replaying a scenario twice gives the same verdict, whatever the wall clock says", async () => {
  // Every scenario carries its own `now`, so this is a property of the data and not of today.
  for (const scenario of scenarios) {
    const first = await run(scenario);
    const second = await run(scenario);
    assert.equal(outcomeOf(first), outcomeOf(second), scenario.key);
    assert.equal(first.rejectedBy ?? first.deferredBy, second.rejectedBy ?? second.deferredBy, scenario.key);
    assert.equal(first.reason, second.reason, scenario.key);
  }
});

test("the default demo carries no legal instrument at all", async () => {
  // This is the finding this slice exists to fix: the first thing a visitor saw was an
  // ordinary reminder evaluated under a US marketing preset.
  const names = preferencePolicy.checks.map((c) => c.preset).filter(Boolean);
  assert.deepEqual(names, [], "the preference policy names no preset");

  const first = scenarios[0];
  assert.equal(first.key, "ok", "the default view is the ordinary day");
  assert.equal(first.policy, "preference");
  assert.equal(inputFor(first).candidate.type, "reminder");

  const decision = await run(first);
  assert.equal(decision.allowed, true);
  assert.ok(
    decision.trace.every((t) => !t.id.startsWith("window:")),
    `no legal window ran in the default demo, trace: ${decision.trace.map((t) => t.id).join(",")}`,
  );
});

test("the commercial scenario is the only one with a preset, and its candidate is commercial", () => {
  const withPreset = scenarios.filter((s) => POLICIES[s.policy].checks.some((c) => c.preset));
  assert.equal(withPreset.length, 1, "exactly one scenario carries a preset");
  const commercial = withPreset[0];
  assert.equal(commercial.key, "commercial");
  assert.equal(commercial.candidate.type, "promotion", "a marketing preset is shown against a marketing message");
  assert.equal(commercial.preset, "usTcpa");
  assert.ok(lib.presets[commercial.preset], "the named preset exists in the library");
});

test("the scoped scenario carries its scope and the date the wording was checked", () => {
  const commercial = scenarios.find((s) => s.key === "commercial");
  assert.equal(commercial.scope, COMMERCIAL_SCOPE);
  assert.match(SCOPE_CHECKED, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(commercial.scope, /not legal advice/i);
  assert.match(commercial.scope, /only when the message is itself commercial/i);
  // The preset's own sourced note is what the page shows beside it, so it has to be there.
  const preset = lib.presets.usTcpa;
  assert.ok(preset.note.length > 0);
  assert.ok(preset.sources.length > 0);
});

test("no scenario claims compliance or legality", () => {
  const claims = /\b(compliant|complies|compliance-checked|lawful|legally safe|guarantee[sd]?)\b/i;
  for (const s of scenarios) {
    for (const field of ["label", "note", "scope"]) {
      const text = s[field];
      if (!text) continue;
      assert.ok(!claims.test(text), `${s.key}.${field} makes a compliance claim: ${text}`);
    }
  }
  // "not a compliance check" is a disclaimer, not a claim, and must survive the rule above.
  assert.match(COMMERCIAL_SCOPE, /not a compliance check/i);
});

test("the page loads the scenario module rather than carrying its own copy", () => {
  const source = readFileSync(PAGE, "utf8");
  assert.match(source, /playground\/scenarios\.mjs/);
  assert.match(source, /evaluateWithPrespend\(/);
  // The data must not be duplicated back into the page, or the two can disagree again.
  assert.ok(!/const scenarios = \[/.test(source), "the page does not redeclare the scenarios");
  assert.ok(!/preset: "usTcpa"/.test(source), "the page does not hard-code the legal preset into a policy");
});

test("the pre-spend really spends the budget through commit, not behind it", async () => {
  const budget = scenarios.find((s) => s.key === "budget");
  assert.equal(budget.deliveredToday, 3);
  const decision = await run(budget);
  assert.equal(decision.rejectedBy, "dailyBudget");
  assert.match(decision.reason, /3 used/, `the counter reached the limit by being spent: ${decision.reason}`);

  // With nothing spent first, the same input is allowed, so the three commits are what stopped it.
  const clean = await evaluateWithPrespend(lib, policyFor(budget), { ...inputFor(budget), deliveredToday: 0 });
  assert.equal(clean.allowed, true);
});
