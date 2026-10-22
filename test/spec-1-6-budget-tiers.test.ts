import { test } from "node:test";
import assert from "node:assert/strict";
import { checks, compilePolicy, createGate, MemoryStore } from "../src/index.js";
import type { Candidate, EvaluateInput, UserState } from "../src/index.js";
import type { BudgetCheck } from "../src/checks.js";

// SPEC 1.6.0 S12. dailyBudget, weeklyBudget and monthlyBudget take `tiers`, a limit per tier name. For the daily
// budget an explicit user.dailyLimit (a finite number of at least 0) wins over every tier. The weekly and monthly
// budgets ignore dailyLimit.

const now = new Date("2026-09-04T12:00:00Z");
const user = (o: Partial<UserState> = {}): UserState => ({ id: "u1", consent: true, ...o });
const candidate = (o: Partial<Candidate> = {}): Candidate => ({ id: "c1", type: "insight", ...o });
const input = (u: UserState, c: Candidate = candidate()): EvaluateInput => ({ user: u, candidate: c, now });

/** Commits one normal candidate for each of `times`, then returns whether one more is allowed. */
const fillAndProbe = async (check: BudgetCheck, u: UserState, times: number) => {
  const gate = createGate({ checks: [check], store: new MemoryStore() });
  for (let i = 0; i < times; i++) {
    const decision = await gate.evaluate(input(u));
    assert.equal(decision.allowed, true, `delivery ${i + 1} of ${times} must fit`);
    assert.equal(await gate.commit(decision, input(u)), true);
  }
  return gate.evaluate(input(u));
};

test("S12: a tier's limit replaces the check's own limit for the daily budget", async () => {
  const tiers = { pro: 3 };
  assert.equal((await fillAndProbe(checks.dailyBudget({ limit: 1, tiers }), user({ tier: "pro" }), 3)).allowed, false);
  assert.equal((await fillAndProbe(checks.dailyBudget({ limit: 1, tiers }), user({ tier: "pro" }), 2)).allowed, true);
});

test("S12: the refusal names the effective limit, not the check's own", async () => {
  const decision = await fillAndProbe(checks.dailyBudget({ limit: 1, tiers: { pro: 3 } }), user({ tier: "pro" }), 3);
  assert.equal(decision.rejectedBy, "dailyBudget");
  assert.match(decision.reason ?? "", /of 3 used/);
});

test("S12: a user with no tier, or a tier that is not in tiers, gets the check's own limit", async () => {
  const check = () => checks.dailyBudget({ limit: 1, tiers: { pro: 3 } });
  assert.equal((await fillAndProbe(check(), user(), 1)).allowed, false);
  assert.equal((await fillAndProbe(check(), user({ tier: "free" }), 1)).allowed, false);
});

test("S12: a tier named like an object property is not a limit", async () => {
  const decision = await fillAndProbe(checks.dailyBudget({ limit: 1, tiers: {} }), user({ tier: "constructor" }), 1);
  assert.equal(decision.allowed, false);
  assert.match(decision.reason ?? "", /of 1 used/);
});

test("S12: an explicit dailyLimit overrides the tier, even when it is lower", async () => {
  const check = () => checks.dailyBudget({ tiers: { pro: 3 } });
  assert.equal((await fillAndProbe(check(), user({ tier: "pro", dailyLimit: 1 }), 1)).allowed, false);
});

test("S12: an explicit dailyLimit of 0 refuses everything", async () => {
  assert.equal((await fillAndProbe(checks.dailyBudget({ tiers: { pro: 3 } }), user({ tier: "pro", dailyLimit: 0 }), 0)).allowed, false);
});

test("S12: a negative or non-finite dailyLimit is not an override", async () => {
  for (const dailyLimit of [-1, Number.POSITIVE_INFINITY, Number.NaN]) {
    const check = checks.dailyBudget({ tiers: { pro: 2 } });
    assert.equal((await fillAndProbe(check, user({ tier: "pro", dailyLimit }), 2)).allowed, false, String(dailyLimit));
  }
});

test("S12: weeklyBudget and monthlyBudget take the tier limit and ignore dailyLimit", async () => {
  const pro = user({ tier: "pro", dailyLimit: 0 });
  assert.equal((await fillAndProbe(checks.weeklyBudget({ limit: 1, tiers: { pro: 2 } }), pro, 2)).allowed, false);
  assert.equal((await fillAndProbe(checks.weeklyBudget({ limit: 1, tiers: { pro: 2 } }), pro, 1)).allowed, true);
  assert.equal((await fillAndProbe(checks.monthlyBudget({ limit: 1, tiers: { pro: 2 } }), pro, 2)).allowed, false);
  assert.equal((await fillAndProbe(checks.monthlyBudget({ limit: 1, tiers: { pro: 2 } }), pro, 1)).allowed, true);
});

test("S12: the near-limit note uses the effective limit", async () => {
  const gate = createGate({ checks: [checks.dailyBudget({ limit: 1, tiers: { pro: 5 } })], store: new MemoryStore() });
  const deliver = async () => gate.commit(await gate.evaluate(input(user({ tier: "pro" }))), input(user({ tier: "pro" })));
  await deliver();
  assert.deepEqual((await gate.evaluate(input(user({ tier: "pro" })))).nearLimit, [], "one of five is not near the limit");
  for (let i = 0; i < 3; i++) await deliver();
  const decision = await gate.evaluate(input(user({ tier: "pro" })));
  assert.deepEqual(decision.nearLimit, [{ check: "dailyBudget", used: 4, limit: 5 }]);
});

test("S12: tiers are accepted by a JSON policy and change the limit", async () => {
  const policy = { specVersion: "1.0.0", checks: [{ id: "dailyBudget", limit: 1, tiers: { pro: 2 } }] };
  assert.doesNotThrow(() => compilePolicy(policy));
  const gate = createGate({ policy, store: new MemoryStore() });
  for (let i = 0; i < 2; i++) await gate.commit(await gate.evaluate(input(user({ tier: "pro" }))), input(user({ tier: "pro" })));
  assert.equal((await gate.evaluate(input(user({ tier: "pro" })))).allowed, false);
});
