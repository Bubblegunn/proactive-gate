/**
 * Properties, not examples. A seeded generator builds many gates, users and
 * candidates, and each test asserts something that must hold for all of them.
 * The generator is a 32-bit PRNG with a fixed seed, so a failure reproduces
 * exactly: the seed is printed in every assertion message.
 *
 * fast-check would do this better, and this package ships zero dependencies,
 * so the generator is forty lines and the shrinking is your own reading.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGate, checks, MemoryStore, SqliteStore, budgetKey } from "../src/index.js";
import type { Candidate, Check, Priority, Store, UserState } from "../src/index.js";

/** mulberry32: small, deterministic, good enough to shake out ordering bugs. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RUNS = 200;
const PRIORITIES: Priority[] = ["low", "normal", "high", "critical"];
const ZONES = ["Europe/Istanbul", "Asia/Tokyo", "America/Los_Angeles", "America/New_York", "Pacific/Apia"];
const TYPES = ["reminder", "insight", "alert", "follow_up"];

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

function genUser(r: () => number): UserState {
  const zone = pick(r, ZONES);
  return {
    id: `u${Math.floor(r() * 1000)}`,
    consent: r() > 0.1,
    proactiveEnabled: r() > 0.1,
    mode: pick(r, ["normal", "focus", "vacation"]),
    intensity: pick(r, ["low", "normal", "high"] as const),
    timezone: zone,
    ...(r() > 0.5 ? { quietHours: { start: "22:00", end: "08:00" } } : {}),
    ...(r() > 0.7 ? { mutedTypes: [pick(r, TYPES)] } : {}),
    ...(r() > 0.8 ? { snoozedUntil: new Date(Date.UTC(2026, 8, 4, 18)).toISOString() } : {}),
    createdAt: new Date(Date.UTC(2026, 8, Math.floor(r() * 4) + 1)).toISOString(),
  };
}

const genCandidate = (r: () => number): Candidate => ({
  id: `c${Math.floor(r() * 100000)}`,
  type: pick(r, TYPES),
  priority: pick(r, PRIORITIES),
  surfaces: ["push", "feed"],
});

const genNow = (r: () => number) => new Date(Date.UTC(2026, 8, 4, Math.floor(r() * 24), Math.floor(r() * 60)));

/** A random subset of the real checks, in a random order, always at least one. */
function genChecks(r: () => number): Check[] {
  const all: Array<() => Check> = [
    () => checks.consent(),
    () => checks.enabled(),
    () => checks.mode({ allow: ["normal", "commute"] }),
    () => checks.snooze({ defer: r() > 0.5 }),
    () => checks.mute(),
    () => checks.intensity(),
    () => checks.quietHours({ priorityFloor: pick(r, PRIORITIES) }),
    () => checks.trustRamp({ days: 7, minPriority: "high" }),
    () => checks.adaptiveTiming(),
    () => checks.dailyBudget({ limit: 1 + Math.floor(r() * 4) }),
  ];
  const chosen = all.filter(() => r() > 0.35).map((f) => f());
  return chosen.length ? chosen : [checks.consent()];
}

test("the trace is always the declared order, with nothing skipped and nothing reordered", async () => {
  for (let seed = 1; seed <= RUNS; seed++) {
    const r = rng(seed);
    const list = genChecks(r);
    const declared = list.map((c) => c.id);
    const gate = createGate({ checks: list, store: new MemoryStore() });
    const input = { user: genUser(r), candidate: genCandidate(r), now: genNow(r) };
    const decision = await gate.evaluate(input);
    const ran = decision.trace.map((t) => t.id);

    assert.deepEqual(ran, declared.slice(0, ran.length), `seed ${seed}: the trace is not a prefix of the declared order`);
    assert.ok(ran.length >= 1, `seed ${seed}: nothing ran`);
    if (decision.allowed) {
      assert.equal(ran.length, declared.length, `seed ${seed}: allowed without running every check`);
    } else {
      const stopper = decision.rejectedBy ?? decision.deferredBy;
      assert.equal(ran.at(-1), stopper, `seed ${seed}: the last check in the trace is not the one that stopped it`);
      assert.ok(decision.reason, `seed ${seed}: stopped without a reason`);
    }
  }
});

test("a check that comes after the stopping check never runs, and every check reports once", async () => {
  for (let seed = 1; seed <= RUNS; seed++) {
    const r = rng(seed + 10_000);
    const list = genChecks(r);
    const calls: string[] = [];
    const watched = list.map((c) => ({ ...c, run: (ctx: Parameters<Check["run"]>[0]) => (calls.push(c.id), c.run(ctx)) }));
    const gate = createGate({ checks: watched, store: new MemoryStore() });
    const decision = await gate.evaluate({ user: genUser(r), candidate: genCandidate(r), now: genNow(r) });
    assert.deepEqual(calls, decision.trace.map((t) => t.id), `seed ${seed}: ran a different set of checks than it reported`);
    assert.equal(new Set(calls).size, calls.length, `seed ${seed}: a check ran twice in one evaluation`);
  }
});

test("a non-rejecting check can never stop a decision, however it misbehaves", async () => {
  for (let seed = 1; seed <= 50; seed++) {
    const r = rng(seed + 20_000);
    const rogue: Check = {
      id: "rogue",
      nonRejecting: true,
      run: () => (r() > 0.5 ? { kind: "reject", reason: "should be ignored" } : { kind: "defer", reason: "also ignored", retryAt: new Date() }),
    };
    const gate = createGate({ checks: [checks.consent(), rogue], store: new MemoryStore() });
    const decision = await gate.evaluate({
      user: { id: "u1", consent: true },
      candidate: genCandidate(r),
      now: genNow(r),
    });
    assert.equal(decision.allowed, true, `seed ${seed}: a non-rejecting check stopped the gate`);
    assert.equal(decision.trace.find((t) => t.id === "rogue")?.outcome, "skip");
  }
});

test("however many deliveries race, commit() never hands out more than the limit", async () => {
  for (let seed = 1; seed <= 60; seed++) {
    const r = rng(seed + 30_000);
    const limit = 1 + Math.floor(r() * 4);
    const racers = 1 + Math.floor(r() * 8);
    const now = genNow(r);
    const user: UserState = { id: `u${seed}`, consent: true, proactiveEnabled: true, timezone: pick(r, ZONES) };
    const store = new MemoryStore();
    const gate = createGate({ checks: [checks.dailyBudget({ limit })], store });

    const inputs = Array.from({ length: racers }, (_, i) => ({ user, candidate: { ...genCandidate(r), id: `c${i}` }, now }));
    const decisions = await Promise.all(inputs.map((i) => gate.evaluate(i)));
    const committed = await Promise.all(decisions.map((d, i) => (d.allowed ? gate.commit(d, inputs[i]!) : Promise.resolve(false))));
    const sent = committed.filter(Boolean).length;

    assert.ok(sent <= limit, `seed ${seed}: ${sent} deliveries committed against a limit of ${limit}`);
    assert.equal(sent, Math.min(racers, limit), `seed ${seed}: expected ${Math.min(racers, limit)} of ${racers} to get through`);
    const used = Number(await store.get(`pg:${budgetKey(user.id, now, user.timezone)}`));
    assert.ok(used >= sent, `seed ${seed}: the counter (${used}) is behind the deliveries (${sent})`);
  }
});

test("replaying the same decision never spends a second unit", async () => {
  for (let seed = 1; seed <= 50; seed++) {
    const r = rng(seed + 40_000);
    const now = genNow(r);
    const user: UserState = { id: `u${seed}`, consent: true, proactiveEnabled: true, timezone: pick(r, ZONES) };
    const gate = createGate({ checks: [checks.dailyBudget({ limit: 3 })], store: new MemoryStore() });
    const input = { user, candidate: genCandidate(r), now };
    const decision = await gate.evaluate(input);
    const retries = 1 + Math.floor(r() * 5);
    const results: boolean[] = [];
    for (let i = 0; i < retries; i++) results.push(await gate.commit(decision, input));
    assert.ok(results.every((x) => x === results[0]), `seed ${seed}: a retry changed the answer`);
    const { budgetUsed } = await gate.inspect(user, now);
    assert.equal(budgetUsed, 1, `seed ${seed}: ${retries} retries spent ${budgetUsed} units`);
  }
});

test("MemoryStore and SqliteStore answer a random operation sequence identically", async () => {
  {
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed + 50_000);
      let clock = Date.UTC(2026, 8, 4);
      const tick = () => clock;
      const memory: Store = new MemoryStore(tick);
      const sqlite = new SqliteStore(":memory:", tick);
      const keys = ["a", "b", "c"];
      try {
        for (let step = 0; step < 40; step++) {
          const key = pick(r, keys);
          const ttl = r() > 0.5 ? 1 + Math.floor(r() * 3) : undefined;
          const op = Math.floor(r() * 5);
          if (op === 0) {
            const value = String(Math.floor(r() * 100));
            await memory.set(key, value, ttl);
            await sqlite.set(key, value, ttl);
          } else if (op === 1) {
            assert.equal(await memory.incr(key, ttl), await sqlite.incr(key, ttl), `seed ${seed} step ${step}: incr disagreed`);
          } else if (op === 2) {
            await memory.del(key);
            await sqlite.del(key);
          } else if (op === 3) {
            clock += Math.floor(r() * 3000);
          } else {
            assert.equal(await memory.get(key), await sqlite.get(key), `seed ${seed} step ${step}: get disagreed on "${key}"`);
          }
        }
        for (const key of keys) {
          assert.equal(await memory.get(key), await sqlite.get(key), `seed ${seed}: final state disagreed on "${key}"`);
        }
      } finally {
        sqlite.close();
      }
    }
  }
});
