/**
 * The simulator, checked against the gate rather than against its own output.
 *
 * A simulation is easy to make convincing and hard to make true, so these tests go after the
 * ways it could lie: counting one candidate twice, letting one policy's store move another's
 * counter, calling a spent budget a delivery, reading a wall clock, or reporting a quiet-hours
 * figure against a fixed curfew instead of against the window each person actually set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defaultChecks, localClock, quietAt } from "../src/checks.js";
import { demoWeek, DEMO_WEEK_DAYS, DEMO_WEEK_NOTE, demoWeekPeople } from "../src/demo-week.js";
import { simulate } from "../src/simulate.js";
import { formatSimulation } from "../src/simulate-report.js";
import type { EvaluateInput, Policy } from "../src/index.js";

const src = (name: string) => readFileSync(fileURLToPath(new URL(`../../src/${name}`, import.meta.url)), "utf8");

const baseline = { label: "no gate" };
const gated = () => ({ label: "proactive-gate", checks: defaultChecks() });

const RESPECTFUL: Policy = {
  specVersion: "1.0.0",
  checks: [{ id: "consent" }, { id: "snooze", defer: true }, { id: "quietHours" }, { id: "dailyBudget", limit: 3 }],
} as Policy;

test("the generated week is a week, and every candidate carries its own instant", () => {
  const events = demoWeek(7);
  assert.ok(events.length > 100, `a week of eight users should be more than a handful: ${events.length}`);
  assert.equal(new Set(events.map((e) => e.candidate.id)).size, events.length, "candidate ids are unique");
  assert.ok(
    events.every((e) => e.now instanceof Date && !Number.isNaN(e.now.getTime())),
    "every event has a usable instant, because nothing in the run may read a clock",
  );
  const first = events[0]?.now?.getTime() ?? 0;
  const last = events[events.length - 1]?.now?.getTime() ?? 0;
  const days = (last - first) / 86400000;
  assert.ok(days > DEMO_WEEK_DAYS - 2 && days <= DEMO_WEEK_DAYS, `spans a week, not a day: ${days.toFixed(2)}`);
  assert.equal(new Set(events.map((e) => e.user.id)).size, demoWeekPeople().length, "every documented person appears");
  assert.ok(events.every((e, i) => i === 0 || (events[i - 1]?.now?.getTime() ?? 0) <= (e.now?.getTime() ?? 0)), "in instant order");
});

test("nothing in the simulator or the week reads a wall clock", () => {
  // Ported from the comparator this replaced: a wall-clock read makes a replay unrepeatable and
  // would be invisible in the output, which is the worst combination a measurement can have.
  for (const file of ["simulate.ts", "demo-week.ts", "simulate-report.ts"]) {
    const text = src(file);
    assert.ok(!/Date\.now\(\)/.test(text), `${file} calls Date.now()`);
    assert.ok(!/new Date\(\s*\)/.test(text), `${file} constructs a Date with no argument`);
  }
});

test("the same seed and the same policies replay to the same result", async () => {
  const events = demoWeek(3);
  const first = await simulate({ events, policies: [baseline, gated()], seed: 3 });
  const second = await simulate({ events, policies: [baseline, gated()], seed: 3 });
  assert.deepEqual(JSON.parse(JSON.stringify(second)), JSON.parse(JSON.stringify(first)));
  assert.equal(formatSimulation(second), formatSimulation(first), "the report is a function of the run");
});

test("the baseline is not a policy: it sends everything", async () => {
  const events = demoWeek(7);
  const result = await simulate({ events, policies: [baseline, gated()] });
  const [none, gate] = result.runs;
  assert.equal(none?.counts.sent, events.length, "no gate delivers every candidate");
  assert.equal(none?.counts.held, 0);
  assert.equal(none?.budget.length, 0, "the baseline spends no budget because it has none");
  assert.ok((gate?.counts.sent ?? 0) < events.length, "the gate holds something, or there is nothing to show");
});

test("final outcomes partition the candidates, so nothing is counted twice", async () => {
  const events = demoWeek(11);
  const result = await simulate({ events, policies: [gated()], transportFailureRate: 0.2, seed: 5 });
  for (const run of result.runs) {
    const c = run.counts;
    assert.equal(
      c.sent + c.held + c.expired + c.lostAtCommit + c.spentNotDelivered,
      c.candidates,
      `${run.label}: every candidate has exactly one final outcome`,
    );
    assert.equal(c.candidates, events.length);
    assert.ok(c.spentNotDelivered > 0, "a 20% failing transport should cost something, or the rate is not wired");
  }
});

test("a spent budget unit is not a delivery", async () => {
  const events = demoWeek(7);
  const result = await simulate({ events, policies: [gated()], transportFailureRate: 1 });
  const run = result.runs[0];
  assert.equal(run?.counts.sent, 0, "a transport that always fails delivers nothing");
  assert.ok((run?.counts.spentNotDelivered ?? 0) > 0, "and the budget units it took are reported as taken");
  assert.ok((run?.budget.length ?? 0) > 0, "read back out of the store, not counted in a variable");
});

test("the default order sends inside a person's own quiet hours only above the floor", async () => {
  const events = demoWeek(7);
  const result = await simulate({ events, policies: [baseline, gated()] });
  const [none, gate] = result.runs;
  assert.ok((none?.counts.sentInQuietHours ?? 0) > 10, "the ungated stream lands in quiet hours often, or the week is wrong");
  assert.equal(
    gate?.counts.sentInQuietHours,
    gate?.counts.sentInQuietHoursByFloor,
    "every quiet-hours delivery under the default order is one the documented priority floor let through",
  );

  // The same claim again, recomputed from the records rather than from the counts, because a
  // headline number that only its own counter agrees with is not evidence.
  const byId = new Map(events.map((e) => [e.candidate.id, e]));
  for (const record of gate?.records ?? []) {
    if (record.outcome !== "sent") continue;
    const event = byId.get(record.candidateId);
    if (!event?.user.quietHours) continue;
    const clock = localClock(new Date(record.at), event.user.timezone ?? "UTC");
    if (quietAt(event.user.quietHours, clock.day, clock.minutes)) {
      assert.equal(event.candidate.priority, "critical", `${record.candidateId} reached a quiet window below the floor`);
    }
  }
});

test("no local day exceeds the daily budget the policy states", async () => {
  const events = demoWeek(7);
  const result = await simulate({ events, policies: [{ label: "capped", policy: RESPECTFUL }] });
  const run = result.runs[0];
  assert.ok((run?.counts.busiestUserDay ?? 0) > 0, "somebody received something");
  assert.ok((run?.counts.busiestUserDay ?? 0) <= 3, `a cap of three was exceeded: ${run?.counts.busiestUserDay}`);
  assert.ok(
    (run?.budget ?? []).every((row) => row.used <= 3),
    "the store agrees with the cap, not only the report",
  );
});

test("a deferral is re-evaluated at its own retryAt, and is not a rejection", async () => {
  // emre is snoozed into the middle of the week and this policy defers rather than rejects.
  const events = demoWeek(7).filter((e) => e.user.id === "emre");
  const result = await simulate({ events, policies: [{ label: "defers", policy: RESPECTFUL }], expirySeconds: 7 * 86400 });
  const run = result.runs[0];
  const deferred = run?.records.filter((r) => r.outcome === "deferred") ?? [];
  assert.ok(deferred.length > 0, "the snooze deferred nothing, so this test proves nothing");
  assert.ok(deferred.every((r) => r.retryAt), "a deferral without a retryAt is a silent drop");
  const retries = run?.records.filter((r) => r.attempt > 1) ?? [];
  assert.ok(retries.length > 0, "nothing was re-evaluated");
  for (const retry of retries) {
    const scheduled = deferred.find((d) => d.candidateId === retry.candidateId);
    assert.equal(retry.at, scheduled?.retryAt, "a retry ran at the instant the deferral asked for");
  }
  assert.ok((run?.counts.sentAfterDeferral ?? 0) > 0, "with a week of room, a snoozed candidate should land later");
});

test("each run gets its own store, so one policy cannot move another's counters", async () => {
  const events = demoWeek(7);
  const twice = await simulate({ events, policies: [gated(), gated()] });
  const [a, b] = twice.runs;
  assert.deepEqual(b?.counts, a?.counts, "the same policy run twice over one stream must agree with itself");
  assert.deepEqual(b?.budget, a?.budget);
  assert.equal(twice.disagreements.length, 0, "a policy cannot disagree with itself");
});

test("the timeline joins the runs on the candidate, and disagreements are a subset of it", async () => {
  const events = demoWeek(7);
  const result = await simulate({ events, policies: [baseline, gated()] });
  assert.equal(result.timeline.length, events.length);
  assert.ok(result.timeline.every((row) => row.cells.length === 2));
  assert.ok(result.disagreements.length > 0);
  assert.ok(result.disagreements.every((row) => row.differences.length > 0), "a disagreement names how the policies differed");
  assert.ok(
    result.disagreements.every((row) => row.differences.includes("outcome") || row.differences.includes("reason") || row.differences.includes("deliveryTime")),
    "and the kind is one of the three a comparison can have",
  );
  assert.equal(
    result.differenceCounts.outcome,
    result.disagreements.filter((row) => row.differences.includes("outcome")).length,
    "the per-kind counts agree with the rows they came from",
  );
  assert.ok(result.disagreements.length <= result.timeline.length);
});

test("the report prints what the run measured, and says what it cannot show", async () => {
  const events = demoWeek(7);
  const result = await simulate({ events, policies: [baseline, gated()] });
  const text = formatSimulation(result, { limit: 5, note: DEMO_WEEK_NOTE, people: demoWeekPeople(), why: true });
  assert.match(text, /no gate/);
  assert.match(text, new RegExp(`delivered\\s+${result.runs[0]?.counts.sent}\\s+${result.runs[1]?.counts.sent}`));
  assert.match(text, /delivered inside their own quiet hours/);
  assert.match(text, /generated week, not anybody's traffic/);
  assert.match(text, /cannot tell you whether a message was wanted/);
  assert.ok(text.split("\n").length < 120, "the default report stays readable in a terminal");
});

test("an empty run is an error rather than an empty table", async () => {
  await assert.rejects(() => simulate({ events: [], policies: [baseline] }), /no events/);
  await assert.rejects(() => simulate({ events: demoWeek(1), policies: [] }), /no policies/);
});

test("events from a file and events from the generator run the same way", async () => {
  const events = demoWeek(2);
  const asFile: EvaluateInput[] = JSON.parse(
    JSON.stringify(events.map((e) => ({ user: e.user, candidate: e.candidate, now: e.now?.toISOString() }))),
  ).map((raw: EvaluateInput & { now: string }) => ({ ...raw, now: new Date(raw.now) }));
  const a = await simulate({ events, policies: [gated()], seed: 2 });
  const b = await simulate({ events: asFile, policies: [gated()], seed: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(b.runs[0]?.counts)), JSON.parse(JSON.stringify(a.runs[0]?.counts)));
});
