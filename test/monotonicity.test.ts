/**
 * Issue #22: can adding a check make the gate louder?
 *
 * The intuition is no, and the intuition is not proof. Budgets are the reason to doubt it: a
 * stricter policy leaves units unspent that a looser one has already consumed, so a candidate
 * arriving later can find room under the stricter policy that it would not have found under the
 * looser one. A check that defers rather than rejects can carry a candidate into the next local
 * day, where it spends a counter the looser policy never reached.
 *
 * So this is an experiment, not a slogan. If it ever finds a stream and a pair where adding a
 * check increased deliveries, the assertion fails and the counterexample is the result: write the
 * mechanism down here rather than loosening the test.
 *
 * Scope of what it checks: deliveries, not holds, over generated weeks from `demo-week.ts`,
 * with a perfect transport so nothing is lost for a reason other than the policy. It says
 * nothing about streams unlike those weeks, and nothing about checks outside the default order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyBudget, defaultChecks, consent, quietHours, snooze } from "../src/checks.js";
import { demoWeek } from "../src/demo-week.js";
import { simulate } from "../src/simulate.js";
import type { Check, EvaluateInput } from "../src/index.js";

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

test("adding a check never increased deliveries, over the default order on three weeks", async () => {
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
          `adding ${all[bit]?.id} raised deliveries from ${before} to ${after}. That is the finding: write the mechanism down rather than loosening this test.`,
        );
      }
    }
  }
  assert.ok(pairs >= 100, `the walk should compare at least a hundred pairs, compared ${pairs}`);
});

test("the two pairs a budget makes suspicious", async () => {
  const events = demoWeek(7);

  // 1. Quiet hours in front of a cap. Under the looser policy the night messages spend the
  //    day's units; under the stricter one they are held, and the units are still there when
  //    the daytime candidates arrive. Same cap, so the total cannot rise, and this is the check.
  const loose = [consent(), dailyBudget({ limit: 3 })];
  const strict = [consent(), quietHours({ priorityFloor: "critical" }), dailyBudget({ limit: 3 })];
  const a = await deliveries(loose, events);
  const b = await deliveries(strict, events);
  assert.ok(b <= a, `quiet hours in front of a cap raised deliveries from ${a} to ${b}`);

  // 2. A deferring snooze in front of a cap, with a week of room so deferrals actually land.
  //    This is the one that could go the other way: a deferral can carry a candidate into the
  //    next local day and spend a counter the looser policy never touched.
  const deferring = [consent(), snooze({ defer: true }), dailyBudget({ limit: 3 })];
  const c = await deliveries(loose, events, 7 * 86400);
  const d = await deliveries(deferring, events, 7 * 86400);
  assert.ok(
    d <= c,
    `a deferring snooze in front of a cap raised deliveries from ${c} to ${d}: a deferral moved work into a later day's budget. Record the mechanism; do not loosen this.`,
  );
});
