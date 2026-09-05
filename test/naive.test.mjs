/**
 * The three shortcuts in bench/naive.mjs, each one shown failing on a real
 * instant, next to the gate deciding the same input correctly. These are the
 * answer to "why not a few if statements": not that the if statements are
 * ugly, but that two of them are wrong twice a year and one is wrong whenever
 * two deliveries are in flight.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGate, checks, MemoryStore, localClock } from "proactive-gate";
import { createNaive, FIXED_OFFSETS } from "../bench/naive.mjs";

const user = (overrides = {}) => ({
  id: "u1",
  consent: true,
  proactiveEnabled: true,
  mode: "normal",
  intensity: "normal",
  createdAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

const candidate = { id: "c1", type: "reminder", priority: "normal", surfaces: ["push"] };

test("a fixed UTC offset wakes the user after the clocks change; the gate reads the zone", async () => {
  // 2026-11-01 is the first Sunday of November: New York leaves daylight time
  // at 02:00 local and goes to UTC-5. A check that captured -4 in the summer
  // still believes it is -4.
  const now = new Date("2026-11-01T12:30:00Z");
  const sleeper = user({ timezone: "America/New_York", quietHours: { start: "22:00", end: "08:00" } });

  const { minutes } = localClock(now, "America/New_York");
  assert.equal(minutes, 7 * 60 + 30, "the real local time is 07:30, inside quiet hours");
  assert.equal(FIXED_OFFSETS["America/New_York"], -4, "the captured offset is the summer one");
  assert.equal((now.getUTCHours() + -4 + 24) % 24, 8, "the shortcut computes 08:00, outside quiet hours");

  const naive = createNaive({ limit: 5 });
  const shortcut = await naive.allow({ user: sleeper, candidate, now });
  assert.equal(shortcut.allowed, true, "the hand-rolled check sends at 07:30 local, half an hour early");

  const gate = createGate({ checks: [checks.quietHours({ priorityFloor: "critical" })], store: new MemoryStore() });
  const decision = await gate.evaluate({ user: sleeper, candidate, now });
  assert.equal(decision.allowed, false);
  assert.equal(decision.rejectedBy, "quietHours");
});

test("a UTC-day budget key silences one user for hours and pays another twice; the gate keys the local day", async () => {
  const limit = 2;
  const gate = () => createGate({ checks: [checks.dailyBudget({ limit })], store: new MemoryStore() });
  const spend = async (g, u, now) => {
    const input = { user: u, candidate, now: new Date(now) };
    const decision = await g.evaluate(input);
    if (decision.allowed) await g.commit(decision, input);
    return decision.allowed;
  };

  // Tokyo is UTC+9, so 01:00 on the 5th local is still the 4th in UTC.
  const tokyo = user({ id: "fatih", timezone: "Asia/Tokyo" });
  const g1 = gate();
  assert.equal(await spend(g1, tokyo, "2026-09-04T00:30:00Z"), true);
  assert.equal(await spend(g1, tokyo, "2026-09-04T02:00:00Z"), true);
  assert.equal(await spend(g1, tokyo, "2026-09-04T04:00:00Z"), false, "the day's two are used");
  assert.equal(await spend(g1, tokyo, "2026-09-04T16:00:00Z"), true, "01:00 on the 5th in Tokyo is a new local day");

  const naiveTokyo = createNaive({ limit });
  for (const t of ["2026-09-04T00:30:00Z", "2026-09-04T02:00:00Z"]) await naiveTokyo.allow({ user: tokyo, candidate, now: new Date(t) });
  const stillYesterday = await naiveTokyo.allow({ user: tokyo, candidate, now: new Date("2026-09-04T16:00:00Z") });
  assert.equal(stillYesterday.allowed, false, "the UTC-day key holds the user on yesterday's budget until 09:00 local");

  // Los Angeles is UTC-7, so 18:00 on the 4th local is already the 5th in UTC.
  const la = user({ id: "gizem", timezone: "America/Los_Angeles" });
  const g2 = gate();
  assert.equal(await spend(g2, la, "2026-09-04T15:00:00Z"), true);
  assert.equal(await spend(g2, la, "2026-09-04T18:00:00Z"), true);
  assert.equal(await spend(g2, la, "2026-09-05T01:00:00Z"), false, "18:00 on the 4th in Los Angeles is the same local day");

  const naiveLa = createNaive({ limit });
  for (const t of ["2026-09-04T15:00:00Z", "2026-09-04T18:00:00Z"]) await naiveLa.allow({ user: la, candidate, now: new Date(t) });
  const freshDay = await naiveLa.allow({ user: la, candidate, now: new Date("2026-09-05T01:00:00Z") });
  assert.equal(freshDay.allowed, true, "the UTC-day key rolled at 17:00 local, so the cap pays out a second time");
});

test("read-then-write spends the last unit twice; commit() takes it once", async () => {
  const limit = 2;
  const now = new Date("2026-09-04T10:00:00Z");
  const racer = user({ id: "race", timezone: "Europe/Istanbul" });

  const naive = createNaive({ limit });
  await naive.allow({ user: racer, candidate, now });
  const both = await Promise.all([
    naive.allow({ user: racer, candidate, now }),
    naive.allow({ user: racer, candidate, now }),
  ]);
  assert.deepEqual(both.map((r) => r.allowed), [true, true], "two deliveries in flight read the same number and both take the last slot");
  assert.equal(naive.counts.get(`race:2026-09-04`), 2, "and the counter only ever reached 2, so nothing looks wrong afterwards");

  const gate = createGate({ checks: [checks.dailyBudget({ limit })], store: new MemoryStore() });
  const first = { user: racer, candidate: { ...candidate, id: "r0" }, now };
  const d0 = await gate.evaluate(first);
  await gate.commit(d0, first);

  const inputs = [
    { user: racer, candidate: { ...candidate, id: "r1" }, now },
    { user: racer, candidate: { ...candidate, id: "r2" }, now },
  ];
  const decisions = await Promise.all(inputs.map((i) => gate.evaluate(i)));
  assert.deepEqual(decisions.map((d) => d.allowed), [true, true], "both evaluate before either sends, as they would in production");
  const committed = await Promise.all(decisions.map((d, i) => gate.commit(d, inputs[i])));
  assert.deepEqual(committed.sort(), [false, true], "commit() is where the unit is taken, and only one of them gets it");
});

test("commit() is idempotent, so a retried delivery does not spend a second unit", async () => {
  const now = new Date("2026-09-04T10:00:00Z");
  const u = user({ id: "retry", timezone: "Europe/Istanbul" });
  const gate = createGate({ checks: [checks.dailyBudget({ limit: 2 })], store: new MemoryStore() });
  const input = { user: u, candidate, now };
  const decision = await gate.evaluate(input);
  assert.equal(await gate.commit(decision, input), true);
  assert.equal(await gate.commit(decision, input), true, "the same decision replays to the same answer");
  const after = await gate.inspect(u, now);
  assert.equal(after.budgetUsed, 1, "one delivery, one unit");
});
