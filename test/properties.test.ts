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
import { createGate, checks, MemoryStore, budgetKey, SqliteStore, PostgresStore } from "../src/index.js";
import { storeContract } from "../src/store-contract.js";
import type { Candidate, Check, PostgresLike, Priority, UserState } from "../src/index.js";

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

class FakePostgresClient implements PostgresLike {
  private readonly rows = new Map<string, { value: string; expires_at: number | null }>();

  async query<T extends Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<{ rows: T[] }> {
    if (text.startsWith("DO $$")) return { rows: [] };

    if (text.startsWith("SELECT value, expires_at FROM proactive_gate_store")) {
      const key = String(params[0]);
      const row = this.rows.get(key);
      return row ? { rows: [row] as unknown as T[] } : { rows: [] };
    }

    if (text.startsWith("INSERT INTO proactive_gate_store (key, value, expires_at) VALUES ($1, $2, $3)")) {
      this.rows.set(String(params[0]), { value: String(params[1]), expires_at: params[2] === null ? null : Number(params[2]) });
      return { rows: [] };
    }

    if (text.startsWith("INSERT INTO proactive_gate_store (key, value, expires_at) VALUES ($1, '1', $2)")) {
      const key = String(params[0]);
      const expiresAt = params[1] === null ? null : Number(params[1]);
      const now = Number(params[2]);
      const current = this.rows.get(key);
      if (!current || (current.expires_at !== null && current.expires_at <= now)) {
        this.rows.set(key, { value: "1", expires_at: expiresAt });
        return { rows: [{ value: "1" }] as unknown as T[] };
      }
      const next = Number(current.value);
      if (!Number.isInteger(next)) throw new Error("invalid input syntax for type bigint");
      const value = String(next + 1);
      this.rows.set(key, { value, expires_at: current.expires_at });
      return { rows: [{ value }] as unknown as T[] };
    }

    if (text.startsWith("DELETE FROM proactive_gate_store WHERE expires_at")) {
      const now = Number(params[0]);
      for (const [key, row] of this.rows) if (row.expires_at !== null && row.expires_at <= now) this.rows.delete(key);
      return { rows: [] };
    }

    if (text.startsWith("DELETE FROM proactive_gate_store WHERE key")) {
      this.rows.delete(String(params[0]));
      return { rows: [] };
    }

    throw new Error(`Unhandled SQL in FakePostgresClient: ${text}`);
  }
}

const sqliteAvailable = (() => {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 5);
})();

storeContract("MemoryStore", (clock) => new MemoryStore(clock));
storeContract("SqliteStore", (clock) => {
  const store = new SqliteStore(":memory:", clock);
  return { store, teardown: () => store.close() };
}, sqliteAvailable ? {} : { skip: "SqliteStore requires Node.js 22.5 or newer" });
storeContract("FakePostgresStore", (clock) => new PostgresStore(new FakePostgresClient(), clock));
