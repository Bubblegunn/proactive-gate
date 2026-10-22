import { test } from "node:test";
import assert from "node:assert/strict";
import { checks, createGate, KNOWN_CHECKS, MemoryStore, presets, SqliteStore } from "../src/index.js";
import type { Candidate, Check, Decision, EvaluateInput, Priority, Store, UserState } from "../src/index.js";

// SPEC 10.2 (client API, not conformance). gate.evaluateSync, commitSync and decideSync run the same decision logic
// as evaluate and commit, with the store read and written synchronously. They refuse, with a TypeError, a store
// without sync methods and a check with no synchronous path.

const now = new Date("2026-10-21T10:00:00Z");
const user = (o: Partial<UserState> = {}): UserState => ({ id: "u1", consent: true, timezone: "UTC", ...o });
const candidate = (o: Partial<Candidate> = {}): Candidate => ({ id: "c1", type: "reminder", priority: "normal", surfaces: ["push"], ...o });
const input = (u: UserState, c: Candidate, at: Date = now): EvaluateInput => ({ user: u, candidate: c, now: at });

/** A store with only the async methods, the shape of a Redis or Postgres store. */
function asyncOnly(inner: MemoryStore): Store {
  return {
    get: (key) => inner.get(key),
    set: (key, value, ttl) => inner.set(key, value, ttl),
    incr: (key, ttl) => inner.incr(key, ttl),
    incrBy: (key, delta, ttl) => inner.incrBy(key, delta, ttl),
    del: (key) => inner.del(key),
  };
}

const isSyncTypeError = (error: unknown) => error instanceof TypeError && /synchronous/.test(error.message);

test("decideSync returns the decision and whether it committed, and the sync commit spends the budget", async () => {
  const store = new MemoryStore();
  const gate = createGate({ checks: [checks.dailyBudget({ limit: 1 })], store });
  const u = user();
  const first = gate.decideSync(input(u, candidate({ id: "a" })));
  assert.equal(first.decision.allowed, true);
  assert.equal(first.committed, true);
  const second = gate.decideSync(input(u, candidate({ id: "b" })));
  assert.equal(second.decision.allowed, false, "the sync commit spent the unit, so the next evaluation is refused");
  assert.equal(second.committed, false);
  assert.equal((await gate.inspect(u, now)).budgetUsed, 1, "the async reader sees the sync writes");
});

test("a store without sync methods makes every sync entry point throw a TypeError that says synchronous", () => {
  const gate = createGate({ checks: [checks.consent()], store: asyncOnly(new MemoryStore()) });
  const a = input(user(), candidate());
  assert.throws(() => gate.evaluateSync(a), isSyncTypeError);
  assert.throws(() => gate.decideSync(a), isSyncTypeError);
  assert.throws(() => gate.commitSync({ id: "x", allowed: true } as Decision, a), isSyncTypeError);
});

test("a custom async check has no synchronous path, so evaluateSync refuses it", () => {
  const asyncCheck: Check = { id: "custom", run: async () => ({ kind: "pass" }) };
  const gate = createGate({ checks: [asyncCheck], store: new MemoryStore() });
  assert.throws(() => gate.evaluateSync(input(user(), candidate())), isSyncTypeError);
});

test("a custom async consume has no synchronous path, so commitSync refuses it", () => {
  const asyncConsume: Check = { id: "custom", run: () => ({ kind: "pass" }), consume: async () => true };
  const gate = createGate({ checks: [asyncConsume], store: new MemoryStore() });
  const a = input(user(), candidate());
  const decision = gate.evaluateSync(a);
  assert.equal(decision.allowed, true);
  assert.throws(() => gate.commitSync(decision, a), isSyncTypeError);
});

test("a pure check whose run returns a plain value runs on the synchronous path without a runSync", () => {
  const pure: Check = { id: "pure", run: () => ({ kind: "reject", reason: "stopped by a plain check" }) };
  const gate = createGate({ checks: [pure], store: new MemoryStore() });
  const decision = gate.evaluateSync(input(user(), candidate()));
  assert.equal(decision.allowed, false);
  assert.equal(decision.rejectedBy, "pure");
});

test("a hook that returns a promise is refused on the synchronous path", () => {
  let calls = 0;
  const gate = createGate({
    checks: [checks.consent()],
    store: new MemoryStore(),
    hooks: { before: async () => { calls++; } },
  });
  assert.throws(() => gate.evaluateSync(input(user(), candidate())), isSyncTypeError);
  assert.equal(calls, 1, "the hook ran once, and its promise was the refusal");
});

test("commitSync refuses a consumer with no consumeSync before any unit is spent, and a retry spends nothing either", async () => {
  const store = new MemoryStore();
  const asyncConsume: Check = { id: "custom", run: () => ({ kind: "pass" }), consume: async () => true };
  const gate = createGate({ checks: [checks.dailyBudget({ limit: 3 }), asyncConsume], store });
  const u = user();
  const a = input(u, candidate({ id: "a" }));
  const decision = gate.evaluateSync(a);
  assert.equal(decision.allowed, true);
  assert.throws(() => gate.commitSync(decision, a), isSyncTypeError);
  assert.equal((await gate.inspect(u, now)).budgetUsed, 0, "the budget was not consumed before the refusal");
  assert.throws(() => gate.commitSync(decision, a), isSyncTypeError);
  assert.equal((await gate.inspect(u, now)).budgetUsed, 0, "the retry did not spend either");
});

test("killSwitch with a plain callback works on the synchronous path; with an async callback it is refused", async () => {
  const on = createGate({ checks: [checks.killSwitch(() => true)], store: new MemoryStore() });
  assert.equal(on.evaluateSync(input(user(), candidate())).rejectedBy, "killSwitch");
  const off = createGate({ checks: [checks.killSwitch(() => false)], store: new MemoryStore() });
  assert.equal(off.evaluateSync(input(user(), candidate())).allowed, true);
  const asyncGate = createGate({ checks: [checks.killSwitch(async () => false)], store: new MemoryStore() });
  assert.throws(() => asyncGate.evaluateSync(input(user(), candidate())), isSyncTypeError);
  assert.equal((await asyncGate.evaluate(input(user(), candidate()))).allowed, true, "the async path still works");
});

test("adaptiveTiming with a plain nextGoodMoment works on the synchronous path; an async one is refused", () => {
  const plain = createGate({ checks: [checks.adaptiveTiming({ nextGoodMoment: () => new Date("2026-10-21T12:00:00Z") })], store: new MemoryStore() });
  assert.equal(plain.evaluateSync(input(user(), candidate())).deliverAt?.toISOString(), "2026-10-21T12:00:00.000Z");
  const asyncGate = createGate({ checks: [checks.adaptiveTiming({ nextGoodMoment: async () => null })], store: new MemoryStore() });
  assert.throws(() => asyncGate.evaluateSync(input(user(), candidate())), isSyncTypeError);
});

// Every built-in check, every preset and the default check list run through decideSync, and agree with evaluate. The
// list of exceptions is empty on purpose: a built-in that cannot run synchronously must be named here with its reason.
const SYNC_EXCEPTIONS: Record<string, string> = {};

test("every KNOWN_CHECKS entry, every preset and defaultChecks run through decideSync and agree with evaluate", async () => {
  const everyConsent = new Proxy({}, { get: () => true });
  const reachable = { id: "u1", consent: true, proactiveEnabled: true, minor: true, timezone: "Asia/Shanghai", consents: everyConsent, lastInboundAt: "2026-10-21T09:00:00Z" } as UserState;
  const cases: Array<[string, () => Check[]]> = [
    ...Object.entries(KNOWN_CHECKS).map(([id, factory]): [string, () => Check[]] => [`check ${id}`, () => [factory({})]]),
    ...Object.entries(presets).map(([name, preset]): [string, () => Check[]] => [`preset ${name}`, () => preset()]),
    ["defaultChecks", () => checks.defaultChecks({ dedupe: true, inboundConsent: true })],
  ];
  let ran = 0;
  for (const [name, build] of cases) {
    if (name in SYNC_EXCEPTIONS) continue;
    const syncGate = createGate({ checks: build(), store: new MemoryStore() });
    const asyncGate = createGate({ checks: build(), store: new MemoryStore() });
    const x = { user: reachable, candidate: candidate({ id: "c1", dedupeKey: "k" }), now };
    const { decision, committed } = syncGate.decideSync(x);
    const expected = await asyncGate.evaluate(x);
    assert.deepEqual(withoutVolatile(decision), withoutVolatile(expected), `${name}: decideSync disagrees with evaluate`);
    assert.equal(committed, expected.allowed ? await asyncGate.commit(expected, x) : false, `${name}: commit disagrees`);
    ran++;
  }
  assert.ok(ran >= 40, `only ${ran} cases ran`);
});

// ---- Properties: the two paths agree on every input ------------------------------------------------------------

/** mulberry32, as in properties.test.ts: a fixed seed, so a failing seed reproduces exactly. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RUNS = 300;
const STEPS = 8;
const TYPES = ["reminder", "insight", "alert", "follow_up"];
const PRIORITIES: Priority[] = ["low", "normal", "high", "critical"];
const ZONES = ["Europe/Istanbul", "Asia/Tokyo", "America/Los_Angeles", "Pacific/Apia", undefined];
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

function genUser(r: () => number): UserState {
  const zone = pick(r, ZONES);
  return {
    id: `u${Math.floor(r() * 3)}`,
    consent: r() > 0.1,
    proactiveEnabled: r() > 0.1,
    ...(zone ? { timezone: zone } : {}),
    ...(r() > 0.5 ? { hourStats: { [String(pick(r, [9, 10]))]: { acted: Math.floor(r() * 3), dismissed: Math.floor(r() * 6) } } } : {}),
    ...(r() > 0.5 ? { lastInboundAt: new Date(Date.UTC(2026, 9, 20, Math.floor(r() * 24))).toISOString() } : {}),
  };
}

function genCandidate(r: () => number): Candidate {
  return {
    id: `c${Math.floor(r() * 4)}`,
    type: pick(r, TYPES),
    priority: pick(r, PRIORITIES),
    surfaces: r() > 0.3 ? ["push", "feed"] : ["push"],
    ...(r() > 0.5 ? { dedupeKey: `k${Math.floor(r() * 3)}` } : {}),
  };
}

// Two hours, so the dead-hour counters and the random user's hourStats are read often.
const genNow = (r: () => number) => new Date(Date.UTC(2026, 9, 20 + Math.floor(r() * 2), pick(r, [9, 10]), Math.floor(r() * 60)));

/** A random subset of the checks that touch the store, plus the pure ones, always at least one. */
function genChecks(r: () => number): Check[] {
  const all: Array<() => Check> = [
    () => checks.consent(),
    () => checks.quietHours(),
    () => checks.dedupe(),
    () => checks.dailyBudget({ limit: 1 + Math.floor(r() * 4) }),
    () => checks.weeklyBudget({ limit: 2 + Math.floor(r() * 4) }),
    () => checks.rateLimit({ limit: 2, perSeconds: 3600 }),
    () => checks.windowBudget({ limit: 2, withinHours: 6 }),
    () => checks.dismissalCooldown({ dismissals: 2 }),
    () => checks.deadHours({ minSamples: 2 }),
    () => checks.inboundConsent(),
  ];
  const chosen = all.filter(() => r() > 0.4).map((make) => make());
  return chosen.length ? chosen : [checks.consent()];
}

/** The store's entries, with each decision id replaced by its position, since ids carry a per-gate token. */
function storeEntries(store: MemoryStore, ids: string[]): Array<[string, string, number | null]> {
  const data = (store as unknown as { data: Map<string, { value: string; expiresAt: number | null }> }).data;
  const normal = (key: string) => ids.reduce((acc, id, i) => acc.split(id).join(`<decision ${i}>`), key);
  return [...data.entries()].map(([key, entry]) => [normal(key), entry.value, entry.expiresAt] as [string, string, number | null]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

const withoutVolatile = (decision: Decision) => ({ ...decision, id: "<id>", trace: decision.trace.map(({ ms: _ms, ...entry }) => entry) });

test("evaluateSync and commitSync agree with evaluate and commit on decisions, traces and store state", async () => {
  for (let seed = 1; seed <= RUNS; seed++) {
    const r = rng(seed + 50_000);
    const list = genChecks(r);
    const storeA = new MemoryStore(() => 0);
    const storeB = new MemoryStore(() => 0);
    const asyncGate = createGate({ checks: list, store: storeA });
    const syncGate = createGate({ checks: list, store: storeB });
    const user = genUser(r);
    const idsA: string[] = [];
    const idsB: string[] = [];
    for (let step = 0; step < STEPS; step++) {
      // A batch evaluates several candidates before any commit, so a commit can lose the race for the last unit (SPEC 5.2, 5.7).
      const batch = r() > 0.6 ? 2 + Math.floor(r() * 2) : 1;
      const inputs: EvaluateInput[] = [];
      for (let k = 0; k < batch; k++) inputs.push({ user, candidate: genCandidate(r), now: genNow(r) });
      if (r() > 0.6) {
        const event = pick(r, ["acted", "dismissed", "dismissed", "delivered"] as const);
        const last = inputs[0]!;
        await asyncGate.record(user, last.candidate, event, last.now);
        await syncGate.record(user, last.candidate, event, last.now);
      }
      const decisionsA: Decision[] = [];
      const decisionsB: Decision[] = [];
      for (const input of inputs) {
        decisionsA.push(await asyncGate.evaluate(input));
        decisionsB.push(syncGate.evaluateSync(input));
      }
      for (let k = 0; k < batch; k++) {
        const input = inputs[k]!;
        const a = decisionsA[k]!;
        const b = decisionsB[k]!;
        idsA.push(a.id);
        idsB.push(b.id);
        assert.deepEqual(withoutVolatile(b), withoutVolatile(a), `seed ${seed} step ${step}.${k}: the decisions differ`);
        const committedA = a.allowed ? await asyncGate.commit(a, input) : false;
        const committedB = b.allowed ? syncGate.commitSync(b, input) : false;
        assert.equal(committedB, committedA, `seed ${seed} step ${step}.${k}: commit results differ`);
      }
    }
    assert.deepEqual(storeEntries(storeB, idsB), storeEntries(storeA, idsA), `seed ${seed}: the store state differs after the same steps`);
  }
});

// SqliteStore is an independent implementation of the same semantics, so it is the oracle for the synchronous MemoryStore
// methods. (Comparing MemoryStore's async methods with its own sync methods would compare the code with itself.)
test("the synchronous MemoryStore methods agree with SqliteStore on random operations", async () => {
  for (let seed = 1; seed <= 60; seed++) {
    const r = rng(seed + 60_000);
    let now = 0;
    const clock = () => now;
    const memory = new MemoryStore(clock);
    const oracle = new SqliteStore(":memory:", clock);
    const keys = ["a", "b", "c"];
    try {
      for (let step = 0; step < 60; step++) {
        const key = pick(r, keys);
        const ttl = r() > 0.5 ? 1 + Math.floor(r() * 3) : undefined;
        const op = Math.floor(r() * 6);
        if (op === 0) {
          const value = String(Math.floor(r() * 100));
          memory.setSync(key, value, ttl);
          await oracle.set(key, value, ttl);
        } else if (op === 1) {
          assert.equal(memory.incrSync(key, ttl), await oracle.incr(key, ttl), `seed ${seed} step ${step}: incr`);
        } else if (op === 2) {
          const delta = Math.floor(r() * 7) - 3;
          assert.equal(memory.incrBySync(key, delta, ttl), await oracle.incrBy(key, delta, ttl), `seed ${seed} step ${step}: incrBy ${delta}`);
        } else if (op === 3) {
          memory.delSync(key);
          await oracle.del(key);
        } else if (op === 4) {
          now += Math.floor(r() * 2000);
        } else {
          assert.equal(memory.getSync(key), await oracle.get(key), `seed ${seed} step ${step}: get`);
        }
      }
    } finally {
      oracle.close();
    }
  }
});
