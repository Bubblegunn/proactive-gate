import { test } from "node:test";
import assert from "node:assert/strict";
import { createGate, MemoryStore, defaultChecks, checks } from "../src/index.js";
import type { Candidate, UserState } from "../src/index.js";

const user = (overrides: Partial<UserState> = {}): UserState => ({
  id: "u1",
  consent: true,
  proactiveEnabled: true,
  mode: "normal",
  intensity: "normal",
  timezone: "Europe/Istanbul",
  createdAt: "2026-01-01T00:00:00Z",
  ...overrides,
});
const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({ id: "c1", type: "reminder", priority: "normal", surfaces: ["push"], ...overrides });
const noon = new Date("2026-09-04T09:00:00Z");

test("dedupe skips when the candidate carries no dedupeKey, and says why", async () => {
  const gate = createGate({ checks: [checks.dedupe()], store: new MemoryStore() });
  const d = await gate.evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(d.allowed, true);
  assert.equal(d.trace[0]?.outcome, "skip");
  assert.match(d.trace[0]?.reason ?? "", /dedupeKey/);
});

test("the same event twice: the first commits, the second is rejected", async () => {
  const store = new MemoryStore();
  const gate = createGate({ checks: [checks.dedupe()], store });
  const first = await gate.evaluate({ user: user(), candidate: candidate({ id: "attempt-1", dedupeKey: "order-42-shipped" }), now: noon });
  assert.equal(first.allowed, true);
  assert.equal(await gate.commit(first, { user: user(), candidate: candidate({ id: "attempt-1", dedupeKey: "order-42-shipped" }), now: noon }), true);

  const second = await gate.evaluate({ user: user(), candidate: candidate({ id: "attempt-2", dedupeKey: "order-42-shipped" }), now: new Date(noon.getTime() + 60_000) });
  assert.equal(second.allowed, false);
  assert.equal(second.rejectedBy, "dedupe");
  assert.match(second.reason ?? "", /already delivered/);
});

test("two workers racing the same event: both pass the check, exactly one commit wins", async () => {
  // This is the failure the check exists for. At-least-once webhook delivery hands the
  // same event to two workers; both evaluate before either has committed, so a check that
  // only reads cannot separate them. The claim has to be atomic and it has to happen at
  // commit time, which is why dedupe implements consume() rather than deciding in run().
  const store = new MemoryStore();
  const gate = createGate({ checks: [checks.dedupe()], store });
  const input = (id: string) => ({ user: user(), candidate: candidate({ id, dedupeKey: "webhook-9" }), now: noon });

  const [a, b] = await Promise.all([gate.evaluate(input("worker-a")), gate.evaluate(input("worker-b"))]);
  assert.equal(a.allowed, true, "both workers see a clean slate");
  assert.equal(b.allowed, true);

  const committed = await Promise.all([gate.commit(a, input("worker-a")), gate.commit(b, input("worker-b"))]);
  assert.deepEqual(committed.filter(Boolean).length, 1, `exactly one commit should win, got ${JSON.stringify(committed)}`);
});

test("a suppressed duplicate does not spend a budget unit", async () => {
  // Ordering is load-bearing: dedupe consumes before the budgets, so when it loses the
  // race the gate stops and the budget is never incremented. Were it the other way round,
  // a duplicate would silently cost the user one of the day's messages.
  const store = new MemoryStore();
  const daily = checks.dailyBudget({ limit: 5 });
  const gate = createGate({ checks: [checks.dedupe(), daily], store });
  const input = (id: string) => ({ user: user(), candidate: candidate({ id, dedupeKey: "same-event" }), now: noon });

  const [a, b] = await Promise.all([gate.evaluate(input("a")), gate.evaluate(input("b"))]);
  const committed = await Promise.all([gate.commit(a, input("a")), gate.commit(b, input("b"))]);
  assert.equal(committed.filter(Boolean).length, 1);

  const state = await gate.inspect(user(), noon);
  assert.equal(state.budgetUsed, 1, "one delivery, one unit");
});

test("the window expires: the same key is deliverable again after it", async () => {
  // The store keeps its own clock, so the test drives it rather than the gate's `now`.
  let clock = noon.getTime();
  const store = new MemoryStore(() => clock);
  const gate = createGate({ checks: [checks.dedupe({ windowSeconds: 60 })], store });
  const input = (id: string, now: Date) => ({ user: user(), candidate: candidate({ id, dedupeKey: "daily-digest" }), now });

  const first = await gate.evaluate(input("a", noon));
  await gate.commit(first, input("a", noon));

  clock = noon.getTime() + 30_000;
  const within = await gate.evaluate(input("b", new Date(clock)));
  assert.equal(within.allowed, false);

  clock = noon.getTime() + 61_000;
  const after = await gate.evaluate(input("c", new Date(clock)));
  assert.equal(after.allowed, true, "past the window the event is a new event");
});

test("keys are per user: one person's delivery does not suppress another's", async () => {
  const store = new MemoryStore();
  const gate = createGate({ checks: [checks.dedupe()], store });
  const input = (userId: string) => ({ user: user({ id: userId }), candidate: candidate({ dedupeKey: "outage-notice" }), now: noon });

  const first = await gate.evaluate(input("u1"));
  await gate.commit(first, input("u1"));

  const other = await gate.evaluate(input("u2"));
  assert.equal(other.allowed, true);
});

test("a JSON policy can name it", async () => {
  const { compilePolicy } = await import("../src/policy.js");
  const options = compilePolicy({ specVersion: "1.1.0", checks: [{ id: "dedupe", windowSeconds: 300 }] });
  assert.deepEqual(options.checks.map((c) => c.id), ["dedupe"]);
});
