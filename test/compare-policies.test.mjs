/**
 * The two-policy comparison, held to the things that make it worth printing.
 *
 * The comparison is only honest if: both policies are the real library, neither run can move
 * the other's counters, the same fixture replays to the same semantic result on any day, and
 * every number in the report comes from the run rather than from a constant. Each of those is
 * a test below.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KNOWN_CHECKS } from "proactive-gate";
import {
  POLICY_A,
  comparePolicies,
  createTransport,
  diffOutcomes,
  finalOutcomes,
  formatReport,
  loadPolicyB,
  loadStream,
  runPolicy,
  summarize,
} from "../bench/compare-policies.mjs";

const MODULE = fileURLToPath(new URL("../bench/compare-policies.mjs", import.meta.url));

/** Only the fields that carry meaning; no decision id and no elapsed milliseconds. */
const semantic = (result) => result.records.map((r) => ({ ...r }));

test("policy A is an honest starting policy, not the deliberately broken rival", () => {
  // bench/naive.mjs exists to lose: it has three real shortcuts in it. A policy-versus-policy
  // comparison that used it would measure nothing, so this file must not touch it.
  const source = readFileSync(MODULE, "utf8");
  const imports = source.split("\n").filter((l) => /^import /.test(l));
  assert.ok(!imports.some((l) => /naive/.test(l)), "does not import the hand-rolled rival");

  // Every check in A is a real library check, run by the real engine.
  for (const entry of POLICY_A.checks) {
    assert.ok(entry.id, "A is built from check ids, not from hand-written if statements");
    assert.ok(Object.keys(KNOWN_CHECKS).includes(entry.id), `${entry.id} is a known check`);
  }
  assert.ok(POLICY_A.checks.length >= 5, "A is a policy someone would really ship, not a stub");
});

test("nothing in the comparator reads a wall clock", () => {
  // Every instant comes from the fixture or from a retryAt the library supplied. A bare
  // `new Date()` or `Date.now()` would make a replay depend on the day it ran.
  const source = readFileSync(MODULE, "utf8");
  const offenders = source
    .split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /\bDate\.now\(\)|new Date\(\s*\)/.test(line) && !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"));
  assert.deepEqual(offenders.map(([n]) => n), [], "a wall-clock read would break replay");
});

test("the same stream and policies replay to the same semantic result", async () => {
  const first = await comparePolicies();
  const second = await comparePolicies();
  assert.deepEqual(semantic(first.a), semantic(second.a));
  assert.deepEqual(semantic(first.b), semantic(second.b));
  assert.deepEqual(first.summaryA, second.summaryA);
  assert.deepEqual(first.summaryB, second.summaryB);
  assert.deepEqual(first.changed, second.changed);
  assert.equal(formatReport(first), formatReport(second), "the report itself is reproducible");
});

test("each policy gets its own store, and neither can move the other's counters", async () => {
  const { a, b } = await comparePolicies();
  assert.notEqual(a.store, b.store);

  // Written into A's store, invisible in B's.
  await a.store.set("pg:crossover-probe", "1");
  assert.equal(await a.store.get("pg:crossover-probe"), "1");
  assert.equal(await b.store.get("pg:crossover-probe"), null);

  // And the budget counters really are separate values, not one shared object.
  const budgetA = new Map(a.budget.map((r) => [`${r.userId}:${r.localDay}`, r.used]));
  const budgetB = new Map(b.budget.map((r) => [`${r.userId}:${r.localDay}`, r.used]));
  assert.ok(budgetA.size > 0 && budgetB.size > 0, "both runs reported budget use");
  // Read per local day, because the key is per local day; fatih crosses midnight in Tokyo.
  assert.ok([...budgetA.keys()].some((k) => k.startsWith("fatih:")), "the crossing-midnight user is reported");
  const incremented = await a.store.incr("pg:budget:probe:2026-09-04");
  assert.equal(incremented, 1);
  assert.equal(await b.store.get("pg:budget:probe:2026-09-04"), null);
});

test("allowed, sent and delivered are three different numbers", async () => {
  const { summaryA, summaryB } = await comparePolicies();
  for (const [name, s] of [["A", summaryA], ["B", summaryB]]) {
    assert.ok(s.allowed >= s.sent, `${name}: allowed is never fewer than sent`);
    assert.equal(s.sent + s.spentNotDelivered + s.lostAtCommit, s.allowed, `${name}: every allowed candidate is accounted for`);
  }
  // The simulated transport must actually refuse something, or the distinction is untested.
  assert.ok(summaryA.spentNotDelivered + summaryB.spentNotDelivered > 0, "the transport refused at least one send");
});

test("the transport's failures come from the run, so changing it changes the figures", async () => {
  // This is the test that a printed number is not a stored statistic.
  const stream = await loadStream();
  const policyB = await loadPolicyB();

  const never = await runPolicy({ label: "t", policy: policyB, lines: stream, transport: createTransport({ seed: 1, failureRate: 0 }) });
  const always = await runPolicy({ label: "t", policy: policyB, lines: stream, transport: createTransport({ seed: 1, failureRate: 1 }) });
  const s0 = summarize(never);
  const s1 = summarize(always);

  assert.equal(s0.spentNotDelivered, 0, "a transport that never fails delivers everything committed");
  assert.ok(s0.sent > 0);
  assert.equal(s1.sent, 0, "a transport that always fails delivers nothing");
  assert.equal(s1.spentNotDelivered, s1.allowed - s1.lostAtCommit, "and every unit it spent is reported as spent");
  // The budget was still spent in both, which is the point worth showing.
  assert.deepEqual(never.budget.map((r) => r.used), always.budget.map((r) => r.used));
});

test("B defers where A has nothing to defer with, and a deferral is re-evaluated from scratch", async () => {
  const { summaryA, summaryB, b } = await comparePolicies();
  assert.equal(summaryA.deferred, 0, "A carries no deferring check, so it must never report one");
  assert.ok(summaryB.deferred > 0, "B defers with snooze");
  assert.ok(summaryB.reEvaluated > 0, "and the demo scheduler re-evaluated it");

  for (const d of summaryB.deferrals) {
    assert.ok(d.retryAt, "a deferral carries the instant to try again");
    assert.ok(d.heldSeconds > 0, "and how long it was held");
    assert.equal(d.by, "snooze");
  }

  // The re-evaluation is a real second evaluation at retryAt, not a stored permission to send.
  const retry = b.records.find((r) => r.attempt > 1);
  const original = b.records.find((r) => r.candidateId === retry.candidateId && r.attempt === 1);
  assert.equal(retry.at, original.retryAt, "it ran at the instant the library asked for");
  assert.ok(retry.at > original.at);
});

test("a deferral held past its expiry is dropped and counted, not sent later anyway", async () => {
  const stream = await loadStream();
  const policyB = await loadPolicyB();
  // One minute of patience: the snooze runs for two hours, so it cannot survive this.
  const impatient = await runPolicy({ label: "t", policy: policyB, lines: stream, transport: createTransport(), expirySeconds: 60 });
  const s = summarize(impatient);

  assert.ok(s.expired > 0, "the deferral expired");
  assert.equal(s.reEvaluated, 0, "and was never re-evaluated");
  assert.ok(s.deferrals.some((d) => d.expired), "the report can name which one");
  // Nothing expired is also counted as sent.
  for (const r of impatient.records.filter((x) => x.expired)) assert.equal(r.sent, false);
});

test("every figure in the summary is recomputed from the records", async () => {
  const { a, b, summaryA, summaryB } = await comparePolicies();
  for (const [result, summary] of [[a, summaryA], [b, summaryB]]) {
    const records = result.records;
    assert.equal(summary.evaluations, records.length);
    assert.equal(summary.candidates, records.filter((r) => r.attempt === 1).length);
    assert.equal(summary.allowed, records.filter((r) => r.allowed).length);
    assert.equal(summary.rejected, records.filter((r) => !r.allowed && !r.deferredBy).length);
    assert.equal(summary.deferred, records.filter((r) => r.deferredBy).length);
    assert.equal(summary.sent, records.filter((r) => r.sent).length);
    assert.equal(summary.reasons.reduce((n, r) => n + r.count, 0), records.filter((r) => r.rejectedBy).length);
    for (const r of summary.reasons) assert.ok(r.example !== undefined, `${r.check} carries an example reason`);
  }
});

test("the candidates that changed decision are named, with what stopped each", async () => {
  const { a, b, changed } = await comparePolicies();
  assert.ok(changed.length > 0, "the two policies disagree somewhere, or the comparison is pointless");
  assert.deepEqual(changed, diffOutcomes(a, b));

  const finalA = finalOutcomes(a);
  const finalB = finalOutcomes(b);
  for (const c of changed) {
    const x = finalA.get(c.candidateId);
    const y = finalB.get(c.candidateId);
    assert.notEqual(`${x.outcome}${x.rejectedBy ?? x.deferredBy ?? ""}`, `${y.outcome}${y.rejectedBy ?? y.deferredBy ?? ""}`, `${c.candidateId} really differs`);
    assert.ok(c.a.outcome && c.b.outcome);
    assert.ok(["policy", "transport"].includes(c.cause), `${c.candidateId} says what caused the difference`);
  }
  // A candidate every policy treats the same must not appear in the diff.
  const same = [...finalA.keys()].filter((id) => !changed.some((c) => c.candidateId === id));
  for (const id of same) {
    assert.equal(finalA.get(id).outcome, finalB.get(id).outcome, `${id} was left out of the diff, so it must match`);
  }
});

test("a difference the fake transport caused is never reported as a policy difference", async () => {
  // The trap this avoids: both gates allow a message and commit the unit, the simulated
  // transport refuses one of them, and the table reads as though a policy decided differently.
  // That number moves with the seed, so presenting it as a policy result would be invented.
  const { changed } = await comparePolicies();
  const transportOnly = changed.filter((c) => c.cause === "transport");
  const policyCaused = changed.filter((c) => c.cause === "policy");

  for (const c of transportOnly) {
    assert.equal(c.a.decision, c.b.decision, `${c.candidateId}: both policies reached the same decision`);
    assert.equal(c.a.by, c.b.by, `${c.candidateId}: and the same check stopped it, namely none`);
    assert.notEqual(c.a.outcome, c.b.outcome, "only delivery differed");
  }
  for (const c of policyCaused) {
    const decidedDifferently = c.a.decision !== c.b.decision || c.a.by !== c.b.by;
    assert.ok(decidedDifferently, `${c.candidateId}: a policy difference really is one`);
  }

  // Changing only the transport seed must not change the policy-caused set.
  const other = await comparePolicies({ seed: 99 });
  assert.deepEqual(
    other.changed.filter((c) => c.cause === "policy").map((c) => `${c.candidateId}:${c.a.by}:${c.b.by}`),
    policyCaused.map((c) => `${c.candidateId}:${c.a.by}:${c.b.by}`),
    "the policy comparison does not depend on the fake transport's luck",
  );
});

test("the report prints the numbers it computed and claims nothing it did not measure", async () => {
  const comparison = await comparePolicies();
  const report = formatReport(comparison);

  const policyCaused = comparison.changed.filter((c) => c.cause === "policy").length;
  const transportCaused = comparison.changed.filter((c) => c.cause === "transport").length;

  assert.match(report, new RegExp(`${comparison.stream.length} candidates`));
  assert.match(report, /allowed, sent and delivered are three numbers/);
  assert.match(report, /not evidence a real person saw or wanted the message/);
  assert.match(report, new RegExp(`${policyCaused} candidates the two policies decided differently`));
  assert.match(report, new RegExp(`${transportCaused} more ended the day differently`));
  // Every figure in the table is one the run produced.
  for (const row of comparison.summaryB.budget) {
    assert.match(report, new RegExp(`${row.userId}\\s+${row.localDay}`), `${row.userId} appears with its local day`);
  }
  // The claims the brief forbids outright.
  assert.ok(!/happier|retention|satisfaction|zero missed/i.test(report), "no outcome nobody measured");
});
