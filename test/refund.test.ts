import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetKey, checks, createGate, MemoryStore, presets } from "../src/index.js";
import { storeContract } from "../src/store-contract.js";
import type { Candidate, Check, EvaluateInput, Store, UserState } from "../src/index.js";

// Client API, not conformance (SPEC 10.1). gate.release gives back the unit that a committed send consumed, so a send
// that failed after commit can be retried without spending the user's budget.

const now = new Date("2026-10-21T10:00:00Z");
const user = (o: Partial<UserState> = {}): UserState => ({ id: "u1", consent: true, timezone: "UTC", ...o });
const candidate = (o: Partial<Candidate> = {}): Candidate => ({ id: "c1", type: "reminder", priority: "normal", surfaces: ["push"], ...o });
const input = (u: UserState, c: Candidate, at: Date = now): EvaluateInput => ({ user: u, candidate: c, now: at });
const budgetCount = async (store: Store, u: UserState, at: Date = now) => Number((await store.get("pg:" + budgetKey(u.id, at, "UTC"))) ?? 0);

test("a released commit frees its unit: the budget allows again", async () => {
  const store = new MemoryStore();
  const gate = createGate({ checks: [checks.dailyBudget({ limit: 1 })], store });
  const u = user();
  const first = input(u, candidate({ id: "a" }));
  const decision = await gate.evaluate(first);
  assert.equal(await gate.commit(decision, first), true);
  const second = input(u, candidate({ id: "b" }));
  assert.equal((await gate.evaluate(second)).allowed, false, "the unit is spent before release");
  assert.equal(await gate.release(decision, first), true);
  assert.equal((await gate.evaluate(second)).allowed, true, "the unit is free after release");
  assert.equal(await budgetCount(store, u), 0);
});

test("release twice refunds once", async () => {
  const store = new MemoryStore();
  const gate = createGate({ checks: [checks.dailyBudget({ limit: 3 })], store });
  const u = user();
  const a = input(u, candidate({ id: "a" }));
  const b = input(u, candidate({ id: "b" }));
  const da = await gate.evaluate(a);
  const db = await gate.evaluate(b);
  assert.equal(await gate.commit(da, a), true);
  assert.equal(await gate.commit(db, b), true);
  assert.equal(await budgetCount(store, u), 2);
  assert.equal(await gate.release(da, a), true);
  assert.equal(await gate.release(da, a), false, "the second release of one decision is refused");
  assert.equal(await budgetCount(store, u), 1, "only the first release gave a unit back");
});

test("release is false for an allowed decision that was never committed, for a rejection, and for a refused commit", async () => {
  const u = user();
  const never = createGate({ checks: [checks.dailyBudget({ limit: 1 })], store: new MemoryStore() });
  const a0 = input(u, candidate({ id: "a0" }));
  const allowedNotCommitted = await never.evaluate(a0);
  assert.equal(allowedNotCommitted.allowed, true);
  assert.equal(await never.release(allowedNotCommitted, a0), false, "an allowed decision that was not committed is not released");

  const store = new MemoryStore();
  const gate = createGate({ checks: [checks.dailyBudget({ limit: 1 })], store });
  const a = input(u, candidate({ id: "a" }));
  const b = input(u, candidate({ id: "b" }));
  const da = await gate.evaluate(a);
  const db = await gate.evaluate(b);
  assert.equal(db.allowed, true, "both are allowed before either commits");
  assert.equal(await gate.commit(da, a), true);
  assert.equal(await gate.commit(db, b), false, "the second commit is refused at the limit");
  assert.equal(await gate.release(db, b), false, "a decision whose commit was refused is not released");
  assert.equal(await budgetCount(store, u), 1, "the refused commit leaves the counter where the committed decision put it");

  const c = input(u, candidate({ id: "c" }));
  const dc = await gate.evaluate(c);
  assert.equal(dc.allowed, false, "the budget is spent, so c is rejected");
  assert.equal(await gate.release(dc, c), false, "a rejected decision was never committed");
});

test("a gate with nothing to give back returns false, because commit recorded nothing for it", async () => {
  const gate = createGate({ checks: [checks.consent()], store: new MemoryStore() });
  const a = input(user(), candidate());
  const decision = await gate.evaluate(a);
  assert.equal(await gate.commit(decision, a), true);
  assert.equal(await gate.release(decision, a), false);
});

test("release never takes a counter below zero when the counter has already gone", async () => {
  const store = new MemoryStore();
  const gate = createGate({ checks: [checks.dailyBudget({ limit: 2 })], store });
  const u = user();
  const a = input(u, candidate({ id: "a" }));
  const decision = await gate.evaluate(a);
  assert.equal(await gate.commit(decision, a), true);
  await store.del("pg:" + budgetKey(u.id, now, "UTC"));
  assert.equal(await gate.release(decision, a), true);
  assert.equal(await budgetCount(store, u), 0, "the counter stays at zero, not minus one");
  assert.equal((await gate.inspect(u, now)).budgetUsed, 0);
});

test("a dedupe claim is released, so the same event can be sent again after a failed send", async () => {
  const store = new MemoryStore();
  const gate = createGate({ checks: [checks.dedupe()], store });
  const u = user();
  const a = input(u, candidate({ id: "a", dedupeKey: "event-1" }));
  const decision = await gate.evaluate(a);
  assert.equal(await gate.commit(decision, a), true);
  assert.equal((await gate.evaluate(a)).allowed, false, "the claim blocks the retry before release");
  assert.equal(await gate.release(decision, a), true);
  assert.equal((await gate.evaluate(a)).allowed, true, "the retry is allowed after release");
});

test("release returns false on a store without incrBy and leaves the counter alone", async () => {
  const full = new MemoryStore();
  const bare: Store = {
    get: (key) => full.get(key),
    set: (key, value, ttl) => full.set(key, value, ttl),
    incr: (key, ttl) => full.incr(key, ttl),
    del: (key) => full.del(key),
  };
  const gate = createGate({ checks: [checks.dailyBudget({ limit: 2 })], store: bare });
  const u = user();
  const a = input(u, candidate({ id: "a" }));
  const decision = await gate.evaluate(a);
  assert.equal(await gate.commit(decision, a), true);
  assert.equal(await gate.release(decision, a), false);
  assert.equal(await budgetCount(full, u), 1);
});

test("twelve concurrent commits across two gates on one store keep the count exact, and releases return it to zero", async () => {
  const LIMIT = 5;
  const RACERS = 12;
  const store = new MemoryStore();
  const gates = [0, 1].map(() => createGate({ checks: [checks.dailyBudget({ limit: LIMIT })], store }));
  const u = user();
  const inputs = Array.from({ length: RACERS }, (_, i) => input(u, candidate({ id: `c${i}` })));
  const decisions = await Promise.all(inputs.map((x, i) => gates[i % 2]!.evaluate(x)));
  const committed = await Promise.all(decisions.map((d, i) => gates[i % 2]!.commit(d, inputs[i]!)));
  assert.equal(committed.filter(Boolean).length, LIMIT, "exactly the limit commits");
  assert.equal(await budgetCount(store, u), LIMIT, "the counter holds exactly the committed units");
  const released = await Promise.all(decisions.map((d, i) => (committed[i] ? gates[(i + 1) % 2]!.release(d, inputs[i]!) : Promise.resolve(false))));
  assert.equal(released.filter(Boolean).length, LIMIT, "every committed decision releases once, from either gate");
  assert.equal(await budgetCount(store, u), 0, "the counter is back to zero");
});

// ---- Per-check claims: a failed refund is retried without a second refund of the checks that finished ---------------

/** A MemoryStore that fails the named operation once for a key prefix. The failure is injected after the write path
 * has been entered, so an operation that throws has not changed the store. */
class FlakyStore implements Store {
  private readonly failures: Array<{ op: "incrBy" | "del"; prefix?: string }> = [];
  constructor(private readonly inner: MemoryStore) {}
  failOnce(op: "incrBy" | "del", prefix?: string): void {
    this.failures.push({ op, ...(prefix ? { prefix } : {}) });
  }
  private check(op: "incrBy" | "del", key: string): void {
    const at = this.failures.findIndex((f) => f.op === op && (f.prefix === undefined || key.includes(f.prefix)));
    if (at >= 0) {
      this.failures.splice(at, 1);
      throw new Error(`injected ${op} failure`);
    }
  }
  get(key: string) { return this.inner.get(key); }
  set(key: string, value: string, ttl?: number) { return this.inner.set(key, value, ttl); }
  incr(key: string, ttl?: number) { return this.inner.incr(key, ttl); }
  incrBy(key: string, delta: number, ttl?: number) { this.check("incrBy", key); return this.inner.incrBy(key, delta, ttl); }
  del(key: string) { this.check("del", key); return this.inner.del(key); }
}

test("a refund that fails in the dedupe check is retried, and the budget check that already refunded is not refunded again", async () => {
  const flaky = new FlakyStore(new MemoryStore());
  const gate = createGate({ checks: [checks.dailyBudget({ limit: 5 }), checks.dedupe()], store: flaky });
  const u = user();
  const a = input(u, candidate({ id: "a", dedupeKey: "event-1" }));
  const b = input(u, candidate({ id: "b" }));
  const da = await gate.evaluate(a);
  assert.equal(await gate.commit(da, a), true);
  const db = await gate.evaluate(b);
  assert.equal(await gate.commit(db, b), true);
  assert.equal((await gate.inspect(u, now)).budgetUsed, 2);

  flaky.failOnce("del", "dedupe:");
  await assert.rejects(gate.release(da, a), /injected del failure/);
  assert.equal((await gate.inspect(u, now)).budgetUsed, 1, "the budget refund that completed before the failure stands");

  assert.equal(await gate.release(da, a), true, "the retry finishes the check that failed");
  assert.equal((await gate.inspect(u, now)).budgetUsed, 1, "the budget was not refunded a second time");
  assert.equal((await gate.evaluate(a)).allowed, true, "the dedupe claim is gone after the retry");
  assert.equal(await gate.release(da, a), false, "every check is refunded now, so a further release does nothing");
});

test("a refund that fails in the budget check is retried once, and the unit comes back exactly once", async () => {
  const flaky = new FlakyStore(new MemoryStore());
  const gate = createGate({ checks: [checks.dailyBudget({ limit: 5 })], store: flaky });
  const u = user();
  const a = input(u, candidate({ id: "a" }));
  const b = input(u, candidate({ id: "b" }));
  const da = await gate.evaluate(a);
  assert.equal(await gate.commit(da, a), true);
  const db = await gate.evaluate(b);
  assert.equal(await gate.commit(db, b), true);

  flaky.failOnce("incrBy");
  await assert.rejects(gate.release(da, a), /injected incrBy failure/);
  assert.equal((await gate.inspect(u, now)).budgetUsed, 2, "a failed refund leaves the unit spent");
  assert.equal(await gate.release(da, a), true);
  assert.equal((await gate.inspect(u, now)).budgetUsed, 1, "one refund, not two: the second committed unit is still counted");
  assert.equal(await gate.release(da, a), false);
});

test("a consumer with no release makes release a no-op, decided before anything is written", async () => {
  const store = new MemoryStore();
  const custom: Check = { id: "custom-send-log", run: () => ({ kind: "pass" }), consume: async () => true };
  const gate = createGate({ checks: [checks.dailyBudget({ limit: 5 }), custom], store });
  const u = user();
  const a = input(u, candidate({ id: "a" }));
  const decision = await gate.evaluate(a);
  assert.equal(await gate.commit(decision, a), true);
  assert.equal(await gate.release(decision, a), false);
  assert.equal((await gate.inspect(u, now)).budgetUsed, 1, "nothing was refunded");
});

// ---- Every preset that has a budget gives its unit back ------------------------------------------------------------

test("every preset with a budget restores the unit after commit and release", async () => {
  // A user who passes every preset's consent, window and recency checks, so the budget is reached. It is a minor in
  // Shanghai at 18:00 local time, which is inside cnMinorMode's window.
  const everyConsent = new Proxy({}, { get: () => true });
  const reachable = { id: "u1", consent: true, proactiveEnabled: true, minor: true, timezone: "Asia/Shanghai", consents: everyConsent, lastInboundAt: "2026-10-21T09:00:00Z" } as UserState;
  const plain = { id: "c1", type: "reminder", priority: "normal", surfaces: ["push", "feed"], channel: "sms" } as Candidate;
  let budgeted = 0;
  for (const [name, preset] of Object.entries(presets)) {
    const list = preset();
    if (!list.some((check) => typeof check.consume === "function")) continue;
    budgeted++;
    const store = new MemoryStore();
    const gate = createGate({ checks: list, store });
    const x = { user: reachable, candidate: plain, now };
    const decision = await gate.evaluate(x);
    assert.equal(decision.allowed, true, `${name}: the test user must reach the budget (${decision.rejectedBy ?? ""})`);
    assert.equal(await gate.commit(decision, x), true, `${name}: commit`);
    const counters = () => [...((store as unknown as { data: Map<string, { value: string }> }).data).entries()].filter(([key]) => !/^pg:(commit|release):/.test(key)).map(([, entry]) => entry.value);
    assert.ok(counters().some((value) => Number(value) >= 1), `${name}: commit spent a unit`);
    assert.equal(await gate.release(decision, x), true, `${name}: release`);
    assert.ok(counters().every((value) => Number(value) === 0), `${name}: every counter is back to zero, got ${counters()}`);
  }
  assert.ok(budgeted >= 5, `only ${budgeted} presets have a budget; the test is not testing the presets`);
});

// ---- The contract with a store that has no incrBy --------------------------------------------------------------------

/** The store as a third party writes it before incrBy existed: the four original methods and nothing else. */
function withoutIncrBy(inner: MemoryStore): Store {
  return {
    get: (key) => inner.get(key),
    set: (key, value, ttl) => inner.set(key, value, ttl),
    incr: (key, ttl) => inner.incr(key, ttl),
    del: (key) => inner.del(key),
  };
}

storeContract("MemoryStore wrapper without incrBy", (clock) => withoutIncrBy(new MemoryStore(clock)));

test("the wrapper without incrBy has no incrBy, and release on it returns false", async () => {
  const store = withoutIncrBy(new MemoryStore());
  assert.equal(store.incrBy, undefined);
  const gate = createGate({ checks: [checks.dailyBudget({ limit: 2 })], store });
  const a = input(user(), candidate({ id: "a" }));
  const decision = await gate.evaluate(a);
  assert.equal(await gate.commit(decision, a), true);
  assert.equal(await gate.release(decision, a), false);
});
