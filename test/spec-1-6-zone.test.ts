import { test } from "node:test";
import assert from "node:assert/strict";
import { checks, compilePolicy, createGate, localClock, MemoryStore } from "../src/index.js";
import type { Candidate, EvaluateInput, UserState } from "../src/index.js";

// SPEC 1.6.0 S2: the effective zone is deviceTimezone when valid, else timezone when valid, else none.
// Every premise below is derived through Intl (localClock, quietAt, inWindow), not written in by hand.

const ISTANBUL = "Europe/Istanbul";
const NEW_YORK = "America/New_York";
const QUIET = { start: "22:00", end: "08:00" };
const candidate: Candidate = { id: "c1", type: "reminder", priority: "normal", surfaces: ["push", "feed"] };
const user = (overrides: Partial<UserState> = {}): UserState => ({
  id: "u1",
  consent: true,
  proactiveEnabled: true,
  mode: "normal",
  intensity: "normal",
  quietHours: QUIET,
  createdAt: "2026-01-01T00:00:00Z",
  ...overrides,
});
const quietIn = (zone: string, now: Date) => {
  const { minutes, day } = localClock(now, zone);
  return checks.quietAt(QUIET, day, minutes) !== null;
};
const decide = (u: UserState, now: Date, list = [checks.quietHours()]) =>
  createGate({ checks: list, store: new MemoryStore() }).evaluate({ user: u, candidate, now });
const noon = new Date("2026-09-04T12:00:00Z");

test("S2: a valid device zone decides quiet hours, ahead of timezone", async () => {
  const now = new Date("2026-09-04T01:00:00Z");
  assert.equal(quietIn(ISTANBUL, now), true, "premise: quiet in Istanbul");
  assert.equal(quietIn(NEW_YORK, now), false, "premise: not quiet in New York");
  assert.equal((await decide(user({ timezone: ISTANBUL, deviceTimezone: NEW_YORK }), now)).allowed, true);
  const zoneOnly = await decide(user({ timezone: ISTANBUL }), now);
  assert.equal(zoneOnly.rejectedBy, "quietHours");
});

test("S2: a device zone that is quiet where timezone is not rejects", async () => {
  const now = new Date("2026-09-04T06:00:00Z");
  assert.equal(quietIn(NEW_YORK, now), true, "premise: quiet in New York");
  assert.equal(quietIn(ISTANBUL, now), false, "premise: not quiet in Istanbul");
  assert.equal((await decide(user({ timezone: ISTANBUL, deviceTimezone: NEW_YORK }), now)).rejectedBy, "quietHours");
  assert.equal((await decide(user({ timezone: ISTANBUL }), now)).allowed, true);
});

test("S2: an invalid device zone falls back to timezone", async () => {
  const now = new Date("2026-09-04T01:00:00Z");
  assert.equal(quietIn(ISTANBUL, now), true, "premise: quiet in Istanbul");
  assert.equal((await decide(user({ timezone: ISTANBUL, deviceTimezone: "Mars/Olympus" }), now)).rejectedBy, "quietHours");
});

test("S2: an invalid timezone with no device zone is no zone, and the default skips", async () => {
  const decision = await decide(user({ timezone: "Not/AZone" }), noon);
  assert.equal(decision.allowed, true);
  assert.equal(decision.trace[0]?.outcome, "skip");
});

test("S2: onMissingTimezone reject rejects a user who has quiet hours and no zone", async () => {
  const decision = await decide(user({}), noon, [checks.quietHours({ onMissingTimezone: "reject" })]);
  assert.equal(decision.rejectedBy, "quietHours");
  assert.match(decision.reason ?? "", /time zone/);
});

test("S2: under reject, the placeholder UTC counts as no zone", async () => {
  const decision = await decide(user({ timezone: "UTC" }), noon, [checks.quietHours({ onMissingTimezone: "reject" })]);
  assert.equal(decision.rejectedBy, "quietHours");
});

test("S2: under reject, a valid device zone rescues the UTC placeholder", async () => {
  assert.equal(quietIn(ISTANBUL, noon), false, "premise: not quiet in Istanbul at noon UTC");
  const decision = await decide(user({ timezone: "UTC", deviceTimezone: ISTANBUL }), noon, [checks.quietHours({ onMissingTimezone: "reject" })]);
  assert.equal(decision.allowed, true);
});

test("S2: under reject, a real timezone is used", async () => {
  const decision = await decide(user({ timezone: ISTANBUL }), noon, [checks.quietHours({ onMissingTimezone: "reject" })]);
  assert.equal(decision.allowed, true);
});

test("S2: under reject, a user with no zone is rejected even without quiet hours (SPEC 9.2.1)", async () => {
  const decision = await decide(user({ quietHours: null }), noon, [checks.quietHours({ onMissingTimezone: "reject" })]);
  assert.equal(decision.allowed, false);
  assert.equal(decision.rejectedBy, "quietHours");
  assert.match(decision.reason ?? "", /time zone/);
});

test("S2: under reject, a valid device zone is enough without quiet hours", async () => {
  const decision = await decide(user({ quietHours: null, deviceTimezone: ISTANBUL }), noon, [checks.quietHours({ onMissingTimezone: "reject" })]);
  assert.equal(decision.allowed, true);
});

test("S2: under reject, a placeholder UTC with a device zone that is quiet at the instant rejects", async () => {
  // 20:00Z is 23:00 in Istanbul (quiet) and 20:00 in UTC (not quiet): the device zone decides.
  const instant = new Date("2026-09-04T20:00:00Z");
  assert.equal(quietIn(ISTANBUL, instant), true, "premise: quiet in Istanbul");
  assert.equal(quietIn("UTC", instant), false, "premise: not quiet in UTC");
  const decision = await decide(user({ timezone: "UTC", deviceTimezone: ISTANBUL }), instant, [checks.quietHours({ onMissingTimezone: "reject" })]);
  assert.equal(decision.rejectedBy, "quietHours");
});

test("S2: compilePolicy accepts skip and reject and throws on any other onMissingTimezone", () => {
  const policy = (value: string) => ({ specVersion: "1.0.0", checks: [{ id: "quietHours", onMissingTimezone: value }] });
  assert.doesNotThrow(() => compilePolicy(policy("skip")));
  assert.doesNotThrow(() => compilePolicy(policy("reject")));
  assert.throws(() => compilePolicy(policy("rejct")), /onMissingTimezone/);
  assert.throws(() => compilePolicy(policy("")), /onMissingTimezone/);
});

test("S2: budget day keys use the effective zone", async () => {
  const now = new Date("2026-09-04T22:30:00Z");
  const deviceDay = localClock(now, NEW_YORK).day;
  const zoneDay = localClock(now, ISTANBUL).day;
  assert.notEqual(deviceDay, zoneDay, "premise: the two zones are on different local days");
  const store = new MemoryStore();
  const gate = createGate({ checks: [checks.dailyBudget({ limit: 5 })], store });
  const input: EvaluateInput = { user: user({ timezone: ISTANBUL, deviceTimezone: NEW_YORK, quietHours: null }), candidate, now };
  const decision = await gate.evaluate(input);
  assert.equal(decision.allowed, true);
  assert.equal(await gate.commit(decision, input), true);
  assert.equal(await store.get(`pg:budget:u1:${deviceDay}`), "1");
  assert.equal(await store.get(`pg:budget:u1:${zoneDay}`), null);
});

test("S2: a timezone of user in allowedWindow reads the effective zone", async () => {
  const now = new Date("2026-09-04T06:00:00Z");
  const window = [checks.allowedWindow({ start: "08:00", end: "21:00", timezone: "user" })];
  assert.equal(checks.inWindow(localClock(now, ISTANBUL).minutes, 480, 1260), true, "premise: inside the window in Istanbul");
  assert.equal(checks.inWindow(localClock(now, NEW_YORK).minutes, 480, 1260), false, "premise: outside it in New York");
  assert.equal((await decide(user({ timezone: NEW_YORK, deviceTimezone: ISTANBUL }), now, window)).allowed, true);
  assert.equal((await decide(user({ timezone: NEW_YORK }), now, window)).rejectedBy, "allowedWindow");
});

test("S2: nextAllowedAt for quiet hours is computed on the effective zone", async () => {
  const now = new Date("2026-09-04T02:00:00Z");
  assert.equal(quietIn(NEW_YORK, now), true, "premise: quiet in New York");
  const device = checks.quietEndsAt(QUIET, NEW_YORK, now);
  const zone = checks.quietEndsAt(QUIET, ISTANBUL, now);
  assert.notEqual(device?.toISOString(), zone?.toISOString(), "premise: the two zones end quiet hours at different instants");
  const decision = await decide(user({ timezone: ISTANBUL, deviceTimezone: NEW_YORK }), now);
  assert.equal(decision.rejectedBy, "quietHours");
  assert.equal(decision.nextAllowedAt?.toISOString(), device?.toISOString());
});
