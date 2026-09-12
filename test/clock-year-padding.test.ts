/**
 * Years below 1000, which `Date.UTC` and `strftime` both get wrong in their own way.
 *
 * The adversarial clock suite (#39) pinned two fixtures here that neither implementation passed,
 * and filed #36, #37 and #38 for them. This file carries the consequences that a fixture cannot
 * express, because a fixture pins a decision and these are about the shape of a storage key.
 *
 * The one worth the file on its own is the monthly budget. `monthlyBudgetKey` takes the first
 * seven characters of the local day: on `2026-06-01` that is the month, on `1-06-01` it is the
 * whole date. So an unpadded year gave every day its own monthly bucket and the monthly cap
 * never bound. A gate that stops working is a bug; a gate that silently stops stopping is worse,
 * and nothing in the suite would have caught it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayBefore, localClock, weekdayOf } from "../src/checks.js";
import { budgetKey, monthlyBudgetKey, weeklyBudgetKey } from "../src/index.js";

/** An instant in a year below 1000, built without `Date.UTC`, which would remap it to the 1900s. */
const at = (year: number, month: number, day: number, hour = 12): Date => {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
};

test("the local day is four digits, whatever the year", () => {
  assert.equal(localClock(at(1, 6, 1), "UTC").day, "0001-06-01");
  assert.equal(localClock(at(99, 6, 1), "UTC").day, "0099-06-01");
  assert.equal(localClock(at(999, 6, 1), "UTC").day, "0999-06-01");
  assert.equal(localClock(at(2026, 6, 1), "UTC").day, "2026-06-01");
});

test("the monthly key stays a month, so the monthly cap still binds", () => {
  const first = monthlyBudgetKey("u", at(1, 6, 1), "UTC");
  const later = monthlyBudgetKey("u", at(1, 6, 15), "UTC");
  assert.equal(first, "monthlyBudget:u:0001-06");
  assert.equal(
    first,
    later,
    "two days of one month must share a monthly bucket; when the year was unpadded they did not, and the cap never bound",
  );
});

test("the weekly key is an ISO week, not NaN and not a negative week number", () => {
  assert.equal(weeklyBudgetKey("u", at(1, 6, 1), "UTC"), "weeklyBudget:u:0001-W22");
  assert.equal(weeklyBudgetKey("u", at(2026, 6, 1), "UTC"), "weeklyBudget:u:2026-W23");
});

test("the daily key is the padded local day", () => {
  assert.equal(budgetKey("u", at(1, 6, 1), "UTC"), "budget:u:0001-06-01");
});

test("calendar arithmetic answers for the year it was given, not for 1900 plus it", () => {
  // 1 June of year 1 is a Friday in the proleptic Gregorian calendar; 1 June 1901 is a Saturday.
  assert.equal(weekdayOf("0001-06-01"), "fri");
  assert.equal(dayBefore("0001-06-01"), "0001-05-31");
  assert.equal(dayBefore("0001-01-01"), "0000-12-31");
});

test("the keys match the Python sibling's, which is what lets one store serve both", () => {
  // Values taken from `proactive_gate.clock` on the same instant; the two implementations
  // disagreed here until #36 and #37 were fixed, so a shared store saw two sets of counters.
  assert.equal(localClock(at(1, 6, 1), "UTC").day, "0001-06-01");
  assert.equal(weeklyBudgetKey("u", at(1, 6, 1), "UTC").split(":").pop(), "0001-W22");
});
