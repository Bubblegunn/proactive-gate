import { test } from "node:test";
import assert from "node:assert/strict";
import { createGate, explain, checks, MemoryStore } from "../src/index.js";
import type { Candidate, Decision, UserState } from "../src/index.js";

// SPEC 1.6.0 S-local. A held decision names the user's clock, in the user's zone and in 24 hours, and says whether
// the message could go out today, tomorrow or later. With no zone the text is unchanged.

const quietUser = (o: Partial<UserState> = {}): UserState => ({ id: "u1", consent: true, createdAt: "2026-01-01T00:00:00Z", quietHours: { start: "22:00", end: "08:00" }, ...o });
const candidate: Candidate = { id: "c1", type: "reminder", surfaces: ["feed"], requested: true };
const quiet = async (user: UserState, now: Date): Promise<Decision> => {
  const gate = createGate({ checks: [checks.quietHours({ onMissingTimezone: "reject" })], store: new MemoryStore() });
  return gate.evaluate({ user, candidate, now });
};

test("Istanbul: a message at 23:15 local is held until 08:00 tomorrow, said in the user's clock", async () => {
  const now = new Date("2026-10-21T20:15:00Z"); // 23:15 in Istanbul (UTC+3)
  const decision = await quiet(quietUser({ timezone: "Europe/Istanbul" }), now);
  const result = explain(decision, { user: { timezone: "Europe/Istanbul" }, now });
  assert.equal(result.localNow, "23:15");
  assert.equal(result.localAvailableAt, "08:00");
  assert.equal(result.when, "tomorrow");
  assert.ok(result.summary.endsWith("It is 23:15 for the user; it could go out at 08:00 tomorrow."), result.summary);
  assert.doesNotMatch(result.summary, /UTC|Z$|T\d\d:\d\d/, "no ISO string and no UTC in the clause");
});

test("the clock is read in the device zone when it is valid, ahead of the stored zone", async () => {
  const now = new Date("2026-10-21T20:15:00Z");
  const decision = await quiet(quietUser({ timezone: "America/New_York", deviceTimezone: "Europe/Istanbul" }), now);
  const result = explain(decision, { user: { timezone: "America/New_York", deviceTimezone: "Europe/Istanbul" }, now });
  assert.equal(result.localNow, "23:15", "Istanbul clock, not New York");
  assert.equal(result.when, "tomorrow");
});

test("Kathmandu (UTC+5:45): a message at 22:45 local is held, and 08:00 tomorrow is the next morning", async () => {
  const now = new Date("2026-10-21T17:00:00Z"); // 22:45 in Kathmandu
  const decision = await quiet(quietUser({ timezone: "Asia/Kathmandu" }), now);
  const result = explain(decision, { user: { timezone: "Asia/Kathmandu" }, now });
  assert.equal(result.localNow, "22:45");
  assert.equal(result.localAvailableAt, "08:00");
  assert.equal(result.when, "tomorrow");
});

test("across midnight: at 00:30 local in the quiet window, the morning is today, not tomorrow", async () => {
  const now = new Date("2026-10-21T21:30:00Z"); // 00:30 on 22 October in Istanbul
  const decision = await quiet(quietUser({ timezone: "Europe/Istanbul" }), now);
  const result = explain(decision, { user: { timezone: "Europe/Istanbul" }, now });
  assert.equal(result.localNow, "00:30");
  assert.equal(result.when, "today");
  assert.ok(result.summary.endsWith("it could go out at 08:00 today."), result.summary);
});

test("New York, spring forward: 22:30 on 7 March EST, out at 08:00 EDT on 8 March, which is tomorrow", async () => {
  const now = new Date("2026-03-08T03:30:00Z"); // 22:30 on 7 March, New York, before the change
  const decision = await quiet(quietUser({ timezone: "America/New_York" }), now);
  const result = explain(decision, { user: { timezone: "America/New_York" }, now });
  assert.equal(result.localNow, "22:30");
  assert.equal(result.localAvailableAt, "08:00", "the wall clock, not the 12:00 UTC instant");
  assert.equal(result.when, "tomorrow");
});

test("New York, fall back: a 25-hour day keeps the same local day, so the morning is today", async () => {
  const now = new Date("2026-11-01T04:30:00Z"); // 00:30 on 1 November, still EDT
  const decision = await quiet(quietUser({ timezone: "America/New_York" }), now);
  const result = explain(decision, { user: { timezone: "America/New_York" }, now });
  assert.equal(result.localNow, "00:30");
  assert.equal(result.localAvailableAt, "08:00");
  assert.equal(result.when, "today");
});

test("New York, fall back: 23:15 on 31 October is held until 08:00 tomorrow, across the change", async () => {
  const now = new Date("2026-11-01T03:15:00Z"); // 23:15 on 31 October, EDT
  const decision = await quiet(quietUser({ timezone: "America/New_York" }), now);
  const result = explain(decision, { user: { timezone: "America/New_York" }, now });
  assert.equal(result.localNow, "23:15");
  assert.equal(result.when, "tomorrow");
});

test("with no valid zone the text is exactly the text explain gives without the option", async () => {
  const now = new Date("2026-10-21T20:15:00Z");
  // The decision has an instant to report (the zone that held it was valid); the user given to explain has no valid zone.
  const decision = await quiet(quietUser({ timezone: "Europe/Istanbul" }), now);
  assert.ok(decision.nextAllowedAt, "premise: the held decision names when it could go out");
  const plain = explain(decision);
  for (const user of [{}, { timezone: "Not/AZone" }, { deviceTimezone: "Not/AZone" }]) {
    const withUser = explain(decision, { user, now });
    assert.equal(withUser.summary, plain.summary);
    assert.equal(withUser.localNow, undefined);
    assert.equal(withUser.when, undefined);
  }
});

test("an allowed decision gets no clause, even with a zone", async () => {
  const now = new Date("2026-10-21T10:00:00Z");
  const decision = await quiet(quietUser({ timezone: "Europe/Istanbul" }), now);
  const result = explain(decision, { user: { timezone: "Europe/Istanbul" }, now });
  assert.equal(decision.allowed, true);
  assert.equal(result.localNow, undefined);
  assert.doesNotMatch(result.summary, /for the user/);
});

test("the clock is read at the instant given, which defaults to the decision's evaluation time", async () => {
  const now = new Date("2026-10-21T20:15:00Z");
  const decision = await quiet(quietUser({ timezone: "Europe/Istanbul" }), now);
  assert.equal(explain(decision, { user: { timezone: "Europe/Istanbul" } }).localNow, "23:15");
  assert.equal(explain(decision, { user: { timezone: "Europe/Istanbul" }, now: new Date("2026-10-21T21:30:00Z") }).localNow, "00:30");
});

test("a hold that lifts two days later is said to be later, with the date on the user's clock", async () => {
  const now = new Date("2026-10-21T10:00:00Z"); // 13:00 in Istanbul
  const snoozedUntil = new Date("2026-10-23T10:00:00Z"); // 13:00 two days later
  const gate = createGate({ checks: [checks.snooze({ defer: true })], store: new MemoryStore() });
  const decision = await gate.evaluate({ user: { id: "u1", consent: true, timezone: "Europe/Istanbul", snoozedUntil }, candidate, now });
  assert.equal(decision.deferredBy, "snooze");
  const result = explain(decision, { user: { timezone: "Europe/Istanbul" }, now });
  assert.equal(result.when, "later");
  assert.equal(result.localAvailableAt, "13:00");
  assert.match(result.summary, /it could go out at 13:00 on 23 October\.$/);
});
