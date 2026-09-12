/**
 * Issue #22 asked for a proof that adding a check can never increase deliveries.
 *
 * **The general claim is false, and this file carries the counterexample.** A check that defers
 * rather than rejects can carry a candidate across a local-day boundary, where it meets a budget
 * counter the looser policy had already spent. Adding that check turns one delivery into two.
 * That is not an engine defect: a deferral is allowed to move work into a later window, and the
 * daily budget is per local day by specification. It is the claim that was too broad.
 *
 * What survives is narrower and still worth having: over the **default order**, whose checks all
 * reject rather than defer, no added check increased deliveries in any pair tried here. That is a
 * measured result over three generated weeks, not a theorem, and it says nothing about policies
 * that include a deferring check, which the counterexample below covers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { consent, dailyBudget, defaultChecks, snooze } from "../src/checks.js";
import { demoWeek } from "../src/demo-week.js";
import { simulate } from "../src/simulate.js";
import type { Check, EvaluateInput, UserState } from "../src/index.js";

/** Deterministic subset of a check list, keeping the default relative order. */
const subsetOf = (checks: Check[], mask: bigint): Check[] => checks.filter((_, i) => (mask >> BigInt(i)) % 2n === 1n);

async function deliveries(checks: Check[], events: EvaluateInput[], expirySeconds = 4 * 3600): Promise<number> {
  const result = await simulate({ events, policies: [{ label: "s", checks }], seed: 1, expirySeconds });
  return result.runs[0]?.counts.sent ?? 0;
}

/**
 * Masks over the whole default order, written out rather than drawn at random, so a failure is
 * reproducible by reading this array. The order is killSwitch, consent, enabled, mode, snooze,
 * mute, intensity, quietHours, trustRamp, dismissalCooldown, adaptiveTiming, dailyBudget, so
 * bit 11 is the budget and several of these deliberately include it.
 */
const MASKS = [
  0b100000000110n,
  0b100010101010n,
  0b100110110110n,
  0b101011011010n,
  0b110101010110n,
  0b111010101010n,
  0b011111110110n,
  0b111101111010n,
  0b000010101010n,
  0b100000000010n,
];

test("the counterexample: adding a deferring check raised deliveries from one to two", async () => {
  // Daily limit of one. The first message is delivered at 10:00 on day one, which spends the day's
  // only unit. The second arrives at 23:50 carrying a snooze that runs to 00:10 on day two.
  //
  //   without snooze: the budget refuses it at 23:50. One delivery.
  //   with snooze({ defer: true }): it is held for twenty minutes and re-evaluated at 00:10, by
  //   which time the local day has rolled over and its budget is untouched. Two deliveries.
  //
  // Reported by review of 0.6.0, reproduced here, and kept as the regression that stops the
  // general claim from being written down again.
  const user = (o: Partial<UserState> = {}): UserState => ({
    id: "u1",
    consent: true,
    proactiveEnabled: true,
    mode: "normal",
    intensity: "normal",
    timezone: "UTC",
    createdAt: "2026-01-01T00:00:00Z",
    ...o,
  });
  const candidate = (id: string) => ({ id, type: "reminder", priority: "normal" as const, surfaces: ["push" as const] });
  const events: EvaluateInput[] = [
    { user: user(), candidate: candidate("first"), now: new Date("2026-09-07T10:00:00Z") },
    { user: user({ snoozedUntil: "2026-09-08T00:10:00Z" }), candidate: candidate("second"), now: new Date("2026-09-07T23:50:00Z") },
  ];

  const without = await deliveries([consent(), dailyBudget({ limit: 1 })], events);
  const with_ = await deliveries([consent(), snooze({ defer: true }), dailyBudget({ limit: 1 })], events);

  assert.equal(without, 1, "one unit a day, so the 23:50 candidate is refused");
  assert.equal(with_, 2, "the deferring policy delivered more, which is the counterexample to the general claim");
  assert.ok(with_ > without, "adding a check increased deliveries");
});

test("over the default order, which defers nothing, no added check increased deliveries", async () => {
  // The scope this claim is allowed to have. `defaultChecks()` contains no deferring check:
  // `snooze()` rejects unless it is explicitly built with { defer: true }, and `adaptiveTiming`
  // postpones a delivery whose unit was already spent at evaluation, so it can lower the number
  // of deliveries and not raise it.
  const weeks = [demoWeek(7), demoWeek(23), demoWeek(101)];
  const all = defaultChecks();
  let pairs = 0;
  for (const events of weeks) {
    for (const mask of MASKS) {
      const smaller = subsetOf(all, mask);
      if (!smaller.length) continue;
      for (let bit = 0; bit < all.length; bit += 1) {
        if ((mask >> BigInt(bit)) % 2n === 1n) continue;
        const larger = subsetOf(all, mask | (1n << BigInt(bit)));
        const before = await deliveries(smaller, events);
        const after = await deliveries(larger, events);
        pairs += 1;
        assert.ok(
          after <= before,
          `adding ${all[bit]?.id} raised deliveries from ${before} to ${after} over a default-order subset. Write the mechanism down; do not loosen this.`,
        );
      }
    }
  }
  assert.ok(pairs >= 100, `the walk should compare at least a hundred pairs, compared ${pairs}`);
});

test("quiet hours in front of a cap cannot raise the total, because the cap bounds both", async () => {
  // The other case a budget makes suspicious, and the one that does hold: under the looser policy
  // the night messages spend the day's units, under the stricter one they are held and the units
  // are still there in the morning. Same cap either way, so the total cannot rise.
  const events = demoWeek(7);
  const loose = [consent(), dailyBudget({ limit: 3 })];
  const strict = [consent(), defaultChecks()[7] as Check, dailyBudget({ limit: 3 })]; // quietHours
  const a = await deliveries(loose, events);
  const b = await deliveries(strict, events);
  assert.ok(b <= a, `quiet hours in front of a cap raised deliveries from ${a} to ${b}`);
});
