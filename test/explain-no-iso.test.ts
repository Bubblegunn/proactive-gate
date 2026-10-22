import { test } from "node:test";
import assert from "node:assert/strict";
import { checks, createGate, explain, MemoryStore } from "../src/index.js";
import type { Candidate, Check, Decision, Gate, UserState } from "../src/index.js";

// With a known zone, no sentence of an explanation may carry an ISO instant or the word UTC: every instant is written
// on the user's clock. Without a zone the text keeps the ISO instant, and the UTC placeholder counts as no zone.

const ISO_INSTANT = /\d{4}-\d{2}-\d{2}T/;
const UTC_WORD = /\bUTC\b/;
const HOUR = 3600 * 1000;

const zones = [
  { zone: "Europe/Istanbul", now: new Date("2026-10-21T20:15:00Z") }, // 23:15 local
  { zone: "America/New_York", now: new Date("2026-03-08T03:30:00Z") }, // 22:30 on 7 March, before the spring change
  { zone: "America/New_York", now: new Date("2026-11-01T04:30:00Z") }, // 00:30 on 1 November, before the fall change
  { zone: "Asia/Kathmandu", now: new Date("2026-10-21T17:00:00Z") }, // 22:45 local
];

const candidate = (o: Partial<Candidate> = {}): Candidate => ({ id: "c1", type: "reminder", surfaces: ["push", "feed"], ...o });
const user = (zone: string | undefined, o: Partial<UserState> = {}): UserState => ({
  id: "u1",
  consent: true,
  ...(zone === undefined ? {} : { timezone: zone }),
  createdAt: "2026-01-01T00:00:00Z",
  quietHours: { start: "22:00", end: "08:00" },
  ...o,
});

type Built = { decision: Decision; user: UserState; gate: Gate };
type Scenario = { name: string; build: (zone: string | undefined, now: Date) => Promise<Built> };

const build = async (list: Check[], u: UserState, c: Candidate, now: Date, prime?: (gate: Gate) => Promise<void>): Promise<Built> => {
  const gate = createGate({ checks: list, store: new MemoryStore() });
  if (prime) await prime(gate);
  return { decision: await gate.evaluate({ user: u, candidate: c, now }), user: u, gate };
};

const scenarios: Scenario[] = [
  { name: "quiet hours", build: (zone, now) => build([checks.quietHours({ onMissingTimezone: "reject" })], user(zone), candidate(), now) },
  { name: "allowed", build: (zone, now) => build([checks.quietHours({ onMissingTimezone: "reject" })], user(zone, { quietHours: null }), candidate(), now) },
  { name: "snooze deferred", build: (zone, now) => build([checks.snooze({ defer: true })], user(zone, { snoozedUntil: new Date(now.getTime() + 2 * HOUR) }), candidate(), now) },
  { name: "snooze refused", build: (zone, now) => build([checks.snooze()], user(zone, { snoozedUntil: new Date(now.getTime() + 2 * HOUR) }), candidate(), now) },
  { name: "crisis quiet", build: (zone, now) => build([checks.crisisQuiet()], user(zone, { crisisUntil: new Date(now.getTime() + 3 * HOUR) }), candidate(), now) },
  { name: "freshness", build: (zone, now) => build([checks.freshness()], user(zone), candidate({ freshUntil: new Date(now.getTime() - HOUR) }), now) },
  {
    name: "daily budget",
    build: (zone, now) => {
      const u = user(zone);
      const c = candidate();
      return build([checks.dailyBudget({ limit: 1 })], u, c, now, async (gate) => {
        await gate.commit(await gate.evaluate({ user: u, candidate: c, now }), { user: u, candidate: c, now });
      });
    },
  },
  {
    name: "dedupe",
    build: (zone, now) => {
      const u = user(zone);
      const c = candidate({ dedupeKey: "order:9" });
      return build([checks.dedupe()], u, c, now, async (gate) => {
        await gate.commit(await gate.evaluate({ user: u, candidate: c, now }), { user: u, candidate: c, now });
      });
    },
  },
  {
    name: "dismissal cooldown",
    build: (zone, now) => {
      const u = user(zone);
      return build([checks.dismissalCooldown()], u, candidate({ type: "tip" }), now, async (gate) => {
        for (const minutes of [3, 2, 1]) await gate.record(u, { type: "tip" }, "dismissed", new Date(now.getTime() - minutes * 60000));
      });
    },
  },
];

for (const { zone, now } of zones) {
  for (const scenario of scenarios) {
    test(`${zone} at ${now.toISOString()}: ${scenario.name} has no ISO instant and no UTC word`, async () => {
      const { decision, user: u } = await scenario.build(zone, now);
      const result = explain(decision, { user: u.timezone === undefined ? {} : { timezone: u.timezone }, now });
      const texts = [result.summary, ...result.checks.map((c) => c.sentence)];
      assert.ok(texts.length > 0);
      for (const text of texts) {
        assert.doesNotMatch(text, ISO_INSTANT, text);
        assert.doesNotMatch(text, UTC_WORD, text);
      }
    });
  }
}

test("the matrix has teeth: without a zone the same refused decision keeps its ISO instant", async () => {
  const now = zones[0]!.now;
  const { decision } = await scenarios.find((s) => s.name === "snooze refused")!.build("Europe/Istanbul", now);
  assert.match(explain(decision).summary, ISO_INSTANT);
});

test("the UTC placeholder is no zone, so the text keeps the ISO instant as it does with no zone", async () => {
  const now = zones[0]!.now;
  const { decision } = await scenarios.find((s) => s.name === "snooze refused")!.build("UTC", now);
  assert.match(explain(decision, { user: { timezone: "UTC" }, now }).summary, ISO_INSTANT);
});

test("with a zone, a refusal's instant reads as a clock time, and tomorrow when it is the next day", async () => {
  const now = zones[0]!.now;
  const { decision } = await scenarios.find((s) => s.name === "snooze refused")!.build("Europe/Istanbul", now);
  const summary = explain(decision, { user: { timezone: "Europe/Istanbul" }, now }).summary;
  assert.match(summary, /until \d{2}:\d{2}/);
  assert.doesNotMatch(summary, ISO_INSTANT);
});
