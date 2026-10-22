import { test } from "node:test";
import assert from "node:assert/strict";
import { checks, createGate, MemoryStore } from "../src/index.js";
import type { Candidate, EvaluateInput, UserState } from "../src/index.js";

// SPEC 1.6.0 S4 and S5. A commitment is something the person set up, such as a reminder they asked for.
// It skips the trust ramp, the dismissal cooldown, mute and every budget, and spends nothing. A requested
// candidate passes the trust ramp. Consent, the kill switch, snooze, quiet hours and dedupe still apply.

const now = new Date("2026-09-04T12:00:00Z");
const oldUser = (o: Partial<UserState> = {}): UserState => ({ id: "u1", consent: true, createdAt: "2026-07-01T00:00:00Z", lastInboundAt: "2026-09-04T09:00:00Z", ...o });
const newUser = (o: Partial<UserState> = {}): UserState => ({ id: "u1", consent: true, createdAt: "2026-09-03T12:00:00Z", ...o });
const candidate = (o: Partial<Candidate> = {}): Candidate => ({ id: "c1", type: "reminder", ...o });
const input = (user: UserState, c: Candidate): EvaluateInput => ({ user, candidate: c, now });

test("S4: a commitment passes an exhausted daily budget and a normal candidate does not", async () => {
  const gate = createGate({ checks: [checks.dailyBudget({ limit: 1 })], store: new MemoryStore() });
  assert.equal(await gate.commit(await gate.evaluate(input(oldUser(), candidate())), input(oldUser(), candidate())), true);
  assert.equal((await gate.evaluate(input(oldUser(), candidate()))).rejectedBy, "dailyBudget");
  assert.equal((await gate.evaluate(input(oldUser(), candidate({ kind: "commitment" })))).allowed, true);
});

const budgets: Record<string, () => ReturnType<typeof checks.dailyBudget>> = {
  dailyBudget: () => checks.dailyBudget({ limit: 1 }),
  weeklyBudget: () => checks.weeklyBudget({ limit: 1 }),
  monthlyBudget: () => checks.monthlyBudget({ limit: 1 }),
  windowBudget: () => checks.windowBudget({ limit: 1, withinHours: 48 }),
  rateLimit: () => checks.rateLimit({ limit: 1, perSeconds: 60 }),
};

for (const [name, make] of Object.entries(budgets)) {
  test(`S4: a commitment passes an exhausted ${name}`, async () => {
    const gate = createGate({ checks: [make()], store: new MemoryStore() });
    const spent = await gate.evaluate(input(oldUser(), candidate()));
    assert.equal(spent.allowed, true, "the first normal candidate must fit the budget");
    assert.equal(await gate.commit(spent, input(oldUser(), candidate())), true);
    assert.equal((await gate.evaluate(input(oldUser(), candidate()))).allowed, false, "the budget must now be exhausted");
    const commitment = await gate.evaluate(input(oldUser(), candidate({ kind: "commitment" })));
    assert.equal(commitment.allowed, true);
    assert.equal(await gate.commit(commitment, input(oldUser(), candidate({ kind: "commitment" }))), true);
  });
}

test("S4: a commitment spends nothing, while a normal candidate spends one unit", async () => {
  const gate = createGate({ checks: [checks.dailyBudget({ limit: 5 })], store: new MemoryStore() });
  const before = (await gate.inspect(oldUser(), now)).budgetUsed;
  const commitment = candidate({ kind: "commitment" });
  assert.equal(await gate.commit(await gate.evaluate(input(oldUser(), commitment)), input(oldUser(), commitment)), true);
  assert.equal((await gate.inspect(oldUser(), now)).budgetUsed, before);
  assert.equal(await gate.commit(await gate.evaluate(input(oldUser(), candidate())), input(oldUser(), candidate())), true);
  assert.equal((await gate.inspect(oldUser(), now)).budgetUsed, before + 1);
});

test("S4: only kind commitment bypasses a budget; a support candidate does not", async () => {
  const gate = createGate({ checks: [checks.dailyBudget({ limit: 1 })], store: new MemoryStore() });
  await gate.commit(await gate.evaluate(input(oldUser(), candidate())), input(oldUser(), candidate()));
  assert.equal((await gate.evaluate(input(oldUser(), candidate({ kind: "support" })))).rejectedBy, "dailyBudget");
});

test("S4: a commitment passes the trust ramp, a normal low priority candidate does not", async () => {
  const gate = createGate({ checks: [checks.trustRamp()], store: new MemoryStore() });
  assert.equal((await gate.evaluate(input(newUser(), candidate({ kind: "commitment", priority: "low" })))).allowed, true);
  assert.equal((await gate.evaluate(input(newUser(), candidate({ priority: "low" })))).rejectedBy, "trustRamp");
});

test("S4: a commitment of a muted type passes mute, a normal candidate of that type does not", async () => {
  const gate = createGate({ checks: [checks.mute()], store: new MemoryStore() });
  const muted = oldUser({ mutedTypes: ["reminder"] });
  assert.equal((await gate.evaluate(input(muted, candidate({ kind: "commitment" })))).allowed, true);
  const refused = await gate.evaluate(input(muted, candidate()));
  assert.equal(refused.rejectedBy, "mute");
  assert.match(refused.reason ?? "", /muted/);
});

test("S4: a commitment passes the dismissal cooldown that silences its type", async () => {
  const gate = createGate({ checks: [checks.dismissalCooldown()], store: new MemoryStore() });
  for (const days of [1, 2, 3]) await gate.record(oldUser(), candidate(), "dismissed", new Date(now.getTime() - days * 86_400_000));
  assert.equal((await gate.evaluate(input(oldUser(), candidate()))).rejectedBy, "dismissalCooldown");
  assert.equal((await gate.evaluate(input(oldUser(), candidate({ kind: "commitment" })))).allowed, true);
});

test("S4: a commitment still meets consent, the kill switch flag, snooze and quiet hours", async () => {
  const consentGate = createGate({ checks: [checks.consent()], store: new MemoryStore() });
  assert.equal((await consentGate.evaluate(input(oldUser({ consent: false }), candidate({ kind: "commitment" })))).rejectedBy, "consent");

  const killGate = createGate({ checks: [checks.killSwitchFlag("proactiveEnabled")], store: new MemoryStore() });
  const killed = await killGate.evaluate({ ...input(oldUser(), candidate({ kind: "commitment" })), flags: { proactiveEnabled: false } });
  assert.equal(killed.rejectedBy, "killSwitch");

  const snoozeGate = createGate({ checks: [checks.snooze()], store: new MemoryStore() });
  assert.equal((await snoozeGate.evaluate(input(oldUser({ snoozedUntil: "2026-09-05T00:00:00Z" }), candidate({ kind: "commitment" })))).rejectedBy, "snooze");

  const quietGate = createGate({ checks: [checks.quietHours()], store: new MemoryStore() });
  const quiet = oldUser({ timezone: "Europe/Istanbul", quietHours: { start: "22:00", end: "08:00" } });
  const atNight = { ...input(quiet, candidate({ kind: "commitment" })), now: new Date("2026-09-04T20:30:00Z") };
  assert.equal((await quietGate.evaluate(atNight)).rejectedBy, "quietHours");
});

test("S4: a commitment still meets dedupe, and a second commit of the same event is refused", async () => {
  const gate = createGate({ checks: [checks.dedupe()], store: new MemoryStore() });
  const commitment = candidate({ kind: "commitment", dedupeKey: "reminder:42" });
  const first = await gate.evaluate(input(oldUser(), commitment));
  assert.equal(await gate.commit(first, input(oldUser(), commitment)), true);
  assert.equal((await gate.evaluate(input(oldUser(), commitment))).rejectedBy, "dedupe");
});

test("S5: a requested candidate passes the trust ramp at low priority, with a reason that says so", async () => {
  const gate = createGate({ checks: [checks.trustRamp()], store: new MemoryStore() });
  const decision = await gate.evaluate(input(newUser(), candidate({ requested: true, priority: "low" })));
  assert.equal(decision.allowed, true);
  assert.match(decision.trace[0]?.reason ?? "", /requested/);
});

test("S5: a requested candidate passes the trust ramp even when the account has no createdAt", async () => {
  const gate = createGate({ checks: [checks.trustRamp()], store: new MemoryStore() });
  assert.equal((await gate.evaluate(input({ id: "u1", consent: true }, candidate({ requested: true, priority: "low" })))).allowed, true);
});

test("S5: requested does not bypass consent", async () => {
  const gate = createGate({ checks: [checks.consent(), checks.trustRamp()], store: new MemoryStore() });
  assert.equal((await gate.evaluate(input(newUser({ consent: false }), candidate({ requested: true, priority: "low" })))).rejectedBy, "consent");
});

test("S5: the ramp still applies to a candidate the person did not request", async () => {
  const gate = createGate({ checks: [checks.trustRamp()], store: new MemoryStore() });
  assert.equal((await gate.evaluate(input(newUser(), candidate({ priority: "low" })))).rejectedBy, "trustRamp");
});
