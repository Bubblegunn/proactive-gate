import { test } from "node:test";
import assert from "node:assert/strict";
import { checks, createGate, MemoryStore } from "../src/index.js";
import type { Candidate, EvaluateInput, UserState } from "../src/index.js";

// SPEC 1.6.0 S11. deadHours takes push off the table in an hour when the user has acted on little of what they
// were sent in that hour. gate.record writes the hourly counters it reads. It never rejects.

const now = new Date("2026-09-04T12:00:00Z");
const utcHour = String(now.getUTCHours());
const user = (o: Partial<UserState> = {}): UserState => ({ id: "u1", consent: true, createdAt: "2026-07-01T00:00:00Z", ...o });
const candidate = (o: Partial<Candidate> = {}): Candidate => ({ id: "c1", type: "insight", surfaces: ["push", "feed"], ...o });
const input = (u: UserState, c: Candidate, at: Date = now): EvaluateInput => ({ user: u, candidate: c, now: at });
const deadHours = () => createGate({ checks: [checks.deadHours()], store: new MemoryStore() });

test("S11: a dead hour removes push and keeps the other surfaces, with a reason that says so", async () => {
  const decision = await deadHours().evaluate(input(user({ hourStats: { [utcHour]: { acted: 1, dismissed: 9 } } }), candidate()));
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.surfaces, ["feed"]);
  assert.match(decision.trace.find((t) => t.id === "deadHours")?.reason ?? "", /dead hour/);
});

test("S11: a candidate that is not on push is not touched", async () => {
  const decision = await deadHours().evaluate(input(user({ hourStats: { [utcHour]: { acted: 0, dismissed: 9 } } }), candidate({ surfaces: ["feed"] })));
  assert.deepEqual(decision.surfaces, ["feed"]);
  assert.equal(decision.trace.find((t) => t.id === "deadHours")?.outcome, "pass");
});

test("S11: a high priority candidate keeps push in a dead hour", async () => {
  const gate = deadHours();
  const u = user({ hourStats: { [utcHour]: { acted: 0, dismissed: 9 } } });
  assert.deepEqual((await gate.evaluate(input(u, candidate({ priority: "high" })))).surfaces, ["push", "feed"]);
  assert.deepEqual((await gate.evaluate(input(u, candidate({ priority: "critical" })))).surfaces, ["push", "feed"]);
  assert.deepEqual((await gate.evaluate(input(u, candidate({ priority: "low" })))).surfaces, ["feed"]);
});

test("S11: five samples is enough and four is not, with the same low rate", async () => {
  const gate = deadHours();
  const dismissedOnly = (n: number) => user({ hourStats: { [utcHour]: { acted: 0, dismissed: n } } });
  const five = dismissedOnly(5);
  const four = dismissedOnly(4);
  assert.deepEqual((await gate.evaluate(input(five, candidate()))).surfaces, ["feed"]);
  assert.deepEqual((await gate.evaluate(input(four, candidate()))).surfaces, ["push", "feed"]);
});

test("S11: an acted rate of exactly 0.2 is not dead; just under it is", async () => {
  const gate = deadHours();
  const at = (acted: number, dismissed: number) => user({ hourStats: { [utcHour]: { acted, dismissed } } });
  const exactly = await gate.evaluate(input(at(1, 4), candidate()));
  assert.deepEqual(exactly.surfaces, ["push", "feed"]);
  const under = await gate.evaluate(input(at(1, 5), candidate()));
  assert.deepEqual(under.surfaces, ["feed"]);
});

test("S11: user.hourStats for the hour replaces the stored counters", async () => {
  const store = new MemoryStore();
  const gate = createGate({ checks: [checks.deadHours()], store });
  for (let i = 0; i < 9; i++) await gate.record(user(), candidate(), "dismissed", now);
  // The stored counters say the hour is dead; the caller's own stats say it is not, and they win.
  const good = user({ hourStats: { [utcHour]: { acted: 9, dismissed: 1 } } });
  assert.deepEqual((await gate.evaluate(input(good, candidate()))).surfaces, ["push", "feed"]);
  assert.deepEqual((await gate.evaluate(input(user(), candidate()))).surfaces, ["feed"]);
});

test("S11: the counters are read in the user's effective zone, not in UTC", async () => {
  const gate = deadHours();
  const istanbul = user({ deviceTimezone: "Europe/Istanbul" });
  for (let i = 0; i < 5; i++) await gate.record(istanbul, candidate(), "dismissed", now);
  // 12:00 UTC is 15:00 in Istanbul; the record and the read agree on the zone, so the same instant is dead.
  assert.deepEqual((await gate.evaluate(input(istanbul, candidate()))).surfaces, ["feed"]);
  assert.deepEqual((await gate.evaluate(input(user(), candidate()))).surfaces, ["push", "feed"]);
});

test("S11: record writes acted and dismissed to their own counters", async () => {
  const gate = deadHours();
  for (let i = 0; i < 5; i++) await gate.record(user(), candidate(), "acted", now);
  // Five acted and no dismissed is a rate of 1, so the hour is not dead. Writing them as dismissed would remove push.
  assert.deepEqual((await gate.evaluate(input(user(), candidate()))).surfaces, ["push", "feed"]);
});

test("S11: delivered and ignored write nothing the check reads", async () => {
  const gate = deadHours();
  for (let i = 0; i < 10; i++) {
    await gate.record(user(), candidate(), "delivered", now);
    await gate.record(user(), candidate(), "ignored", now);
  }
  // Ten deliveries and ten ignores are no samples: below the five-sample floor, push stays.
  assert.deepEqual((await gate.evaluate(input(user(), candidate()))).surfaces, ["push", "feed"]);
});

test("L5: a non-numeric stored counter on the synchronous path does not make the hour dead either", () => {
  const store = new MemoryStore();
  store.setSync(`pg:hours:u1:${utcHour}:acted`, "x");
  store.setSync(`pg:hours:u1:${utcHour}:dismissed`, "9");
  const decision = createGate({ checks: [checks.deadHours()], store }).evaluateSync(input(user(), candidate()));
  assert.deepEqual(decision.surfaces, ["push", "feed"]);
});

test("L5: on the synchronous path a missing stored count is zero, so nine stored dismissals alone make the hour dead", () => {
  const store = new MemoryStore();
  store.setSync(`pg:hours:u1:${utcHour}:dismissed`, "9");
  const decision = createGate({ checks: [checks.deadHours()], store }).evaluateSync(input(user(), candidate()));
  assert.deepEqual(decision.surfaces, ["feed"]);
});

test("L5: stored counts are read as numbers on the synchronous path, so acted 0 and dismissed 9 is dead", () => {
  const store = new MemoryStore();
  store.setSync(`pg:hours:u1:${utcHour}:acted`, "0");
  store.setSync(`pg:hours:u1:${utcHour}:dismissed`, "9");
  const decision = createGate({ checks: [checks.deadHours()], store }).evaluateSync(input(user(), candidate()));
  assert.deepEqual(decision.surfaces, ["feed"]);
});
