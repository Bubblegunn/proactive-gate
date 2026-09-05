import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGate, MemoryStore, SqliteStore, defaultChecks, checks, localClock, inWindow } from "../src/index.js";
import type { Candidate, Store, UserState } from "../src/index.js";
import { replay, summarize } from "../src/cli.js";

const user = (overrides: Partial<UserState> = {}): UserState => ({
  id: "u1",
  consent: true,
  proactiveEnabled: true,
  mode: "normal",
  intensity: "normal",
  timezone: "Europe/Istanbul",
  quietHours: { start: "22:00", end: "08:00" },
  createdAt: "2026-01-01T00:00:00Z",
  ...overrides,
});
const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({ id: "c1", type: "reminder", priority: "normal", surfaces: ["push", "feed"], ...overrides });
const noon = new Date("2026-09-04T09:00:00Z"); // 12:00 in Istanbul (UTC+3)
const night = new Date("2026-09-04T20:30:00Z"); // 23:30 in Istanbul

test("happy path: every check passes, surfaces are returned, trace lists all twelve", async () => {
  const gate = createGate({ checks: defaultChecks() });
  const d = await gate.evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(d.allowed, true);
  assert.deepEqual(d.surfaces, ["push", "feed"]);
  assert.equal(d.trace.length, 12);
  assert.deepEqual(d.trace.map((t) => t.id), ["killSwitch", "consent", "enabled", "mode", "snooze", "mute", "intensity", "quietHours", "trustRamp", "dismissalCooldown", "adaptiveTiming", "dailyBudget"]);
});

test("order is visible: consent rejects before quiet hours gets a chance", async () => {
  const gate = createGate({ checks: defaultChecks() });
  const d = await gate.evaluate({ user: user({ consent: false }), candidate: candidate(), now: night });
  assert.equal(d.allowed, false);
  assert.equal(d.rejectedBy, "consent");
  assert.equal(d.trace.length, 2);
});

test("kill switch silences everything and says so", async () => {
  const gate = createGate({ checks: defaultChecks({ killSwitch: () => true }) });
  const d = await gate.evaluate({ user: user(), candidate: candidate({ priority: "critical" }), now: noon });
  assert.equal(d.rejectedBy, "killSwitch");
  assert.match(d.reason!, /kill switch/);
});

test("quiet hours: rejects at 23:30 local, passes at noon, crosses midnight, bypassed at the floor", async () => {
  const gate = createGate({ checks: [checks.quietHours({ priorityFloor: "high" })] });
  const late = await gate.evaluate({ user: user(), candidate: candidate(), now: night });
  assert.equal(late.rejectedBy, "quietHours");
  assert.match(late.reason!, /22:00 to 08:00 Europe\/Istanbul/);
  const early = await gate.evaluate({ user: user(), candidate: candidate(), now: new Date("2026-09-05T03:30:00Z") }); // 06:30 local
  assert.equal(early.allowed, false);
  const day = await gate.evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(day.allowed, true);
  const urgent = await gate.evaluate({ user: user(), candidate: candidate({ priority: "high" }), now: night });
  assert.equal(urgent.allowed, true);
  const noTz = await gate.evaluate({ user: user({ timezone: undefined as unknown as string }), candidate: candidate(), now: night });
  assert.equal(noTz.allowed, true);
  assert.equal(noTz.trace[0]?.outcome, "skip");
});

test("localClock and inWindow handle zones and midnight", () => {
  assert.equal(localClock(new Date("2026-09-04T20:30:00Z"), "Europe/Istanbul").minutes, 23 * 60 + 30);
  assert.equal(localClock(new Date("2026-09-04T20:30:00Z"), "America/Los_Angeles").minutes, 13 * 60 + 30);
  assert.equal(localClock(new Date("2026-09-04T23:30:00Z"), "Europe/Istanbul").day, "2026-09-05");
  assert.equal(inWindow(23 * 60, 22 * 60, 8 * 60), true);
  assert.equal(inWindow(7 * 60, 22 * 60, 8 * 60), true);
  assert.equal(inWindow(12 * 60, 22 * 60, 8 * 60), false);
  assert.equal(inWindow(12 * 60, 9 * 60, 17 * 60), true);
  assert.equal(inWindow(12 * 60, 12 * 60, 12 * 60), false);
});

test("trust ramp: new users hear only high priority for seven days", async () => {
  const gate = createGate({ checks: [checks.trustRamp()] });
  const fresh = user({ createdAt: "2026-09-02T00:00:00Z" });
  const normal = await gate.evaluate({ user: fresh, candidate: candidate(), now: noon });
  assert.equal(normal.rejectedBy, "trustRamp");
  assert.match(normal.reason!, /day 3 of 7/);
  const high = await gate.evaluate({ user: fresh, candidate: candidate({ priority: "high" }), now: noon });
  assert.equal(high.allowed, true);
  const old = await gate.evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(old.allowed, true);
});

test("intensity maps to a priority floor", async () => {
  const gate = createGate({ checks: [checks.intensity()] });
  assert.equal((await gate.evaluate({ user: user({ intensity: "low" }), candidate: candidate(), now: noon })).rejectedBy, "intensity");
  assert.equal((await gate.evaluate({ user: user({ intensity: "low" }), candidate: candidate({ priority: "high" }), now: noon })).allowed, true);
  assert.equal((await gate.evaluate({ user: user({ intensity: "high" }), candidate: candidate({ priority: "low" }), now: noon })).allowed, true);
});

test("snooze, mute, mode and enabled each reject with a specific reason", async () => {
  const gate = createGate({ checks: defaultChecks() });
  const cases: Array<[Partial<UserState>, string]> = [
    [{ snoozedUntil: "2026-09-04T12:00:00Z" }, "snooze"],
    [{ mutedTypes: ["reminder"] }, "mute"],
    [{ mode: "focus" }, "mode"],
    [{ proactiveEnabled: false }, "enabled"],
  ];
  for (const [overrides, expected] of cases) {
    const d = await gate.evaluate({ user: user(overrides), candidate: candidate(), now: noon });
    assert.equal(d.rejectedBy, expected, `expected ${expected} to reject`);
  }
});

test("dismissal cooldown: three dismissals in thirty days buy a week of silence for that type only", async () => {
  const store = new MemoryStore();
  const gate = createGate({ store, checks: [checks.dismissalCooldown()] });
  const u = user();
  for (const day of [1, 2, 3]) await gate.record(u, { type: "reminder" }, "dismissed", new Date(`2026-09-0${day}T10:00:00Z`));
  const silenced = await gate.evaluate({ user: u, candidate: candidate(), now: new Date("2026-09-05T10:00:00Z") });
  assert.equal(silenced.rejectedBy, "dismissalCooldown");
  assert.match(silenced.reason!, /silent until 2026-09-10T10:00:00.000Z/);
  const otherType = await gate.evaluate({ user: u, candidate: candidate({ type: "insight" }), now: new Date("2026-09-05T10:00:00Z") });
  assert.equal(otherType.allowed, true);
  const later = await gate.evaluate({ user: u, candidate: candidate(), now: new Date("2026-09-11T10:00:00Z") });
  assert.equal(later.allowed, true);
  await gate.record(u, { type: "reminder" }, "acted");
  const acted = await gate.evaluate({ user: u, candidate: candidate(), now: new Date("2026-09-11T10:00:00Z") });
  assert.equal(acted.allowed, true);
});

test("daily budget: evaluate reads, commit consumes atomically and refuses the sixth delivery", async () => {
  const store = new MemoryStore();
  const gate = createGate({ store, checks: [checks.dailyBudget({ limit: 5 })] });
  const input = { user: user(), candidate: candidate(), now: noon };
  for (let i = 0; i < 5; i++) {
    const d = await gate.evaluate(input);
    assert.equal(d.allowed, true, `delivery ${i + 1} should be allowed`);
    assert.equal(await gate.commit(d, input), true);
  }
  const sixth = await gate.evaluate(input);
  assert.equal(sixth.rejectedBy, "dailyBudget");
  assert.match(sixth.reason!, /5 used \(5\)/);
  // Two instances that both evaluated before either committed: only one wins.
  const store2 = new MemoryStore();
  const gate2 = createGate({ store: store2, checks: [checks.dailyBudget({ limit: 1 })] });
  const a = await gate2.evaluate(input);
  const b = await gate2.evaluate(input);
  assert.equal(a.allowed && b.allowed, true);
  assert.equal(await gate2.commit(a, input), true);
  assert.equal(await gate2.commit(b, input), false);
  // The budget resets on the user's local day, not UTC.
  const nextLocalDay = new Date("2026-09-04T21:30:00Z"); // 00:30 next day in Istanbul
  assert.equal((await gate.evaluate({ ...input, now: nextLocalDay })).allowed, true);
  assert.equal((await gate.inspect(user(), noon)).budgetUsed, 5);
});

test("weekly budget: resets on the user's local ISO week and commits atomically", async () => {
  const store = new MemoryStore();
  const gate = createGate({ store, checks: [checks.weeklyBudget({ limit: 2 })] });
  const input = { user: user(), candidate: candidate(), now: new Date("2026-09-04T09:00:00Z") };
  const first = await gate.evaluate(input);
  const second = await gate.evaluate(input);
  assert.equal(await gate.commit(first, input), true);
  assert.equal(await gate.commit(second, input), true);
  assert.equal((await gate.evaluate(input)).rejectedBy, "weeklyBudget");

  const nextWeek = await gate.evaluate({ ...input, now: new Date("2026-09-07T09:00:00Z") });
  assert.equal(nextWeek.allowed, true);
});

const sqliteAvailable = Number(process.versions.node.split(".")[0]) >= 22;

test("sqlite store supports get, set, increment, delete and expiration", { skip: !sqliteAvailable }, async () => {
  let now = 1_000_000;
  const store = new SqliteStore(":memory:", () => now);
  assert.equal(await store.get("missing"), null);
  await store.set("key", "value");
  assert.equal(await store.get("key"), "value");
  assert.equal(await store.incr("counter"), 1);
  assert.equal(await store.incr("counter", 10), 2);
  assert.equal(await store.get("counter"), "2");
  await store.set("temporary", "value", 5);
  assert.equal(await store.get("temporary"), "value");
  now += 5000;
  assert.equal(await store.get("temporary"), null);
  await store.del("key");
  assert.equal(await store.get("key"), null);
  store.close();
});

test("sqlite store preserves values across database connections", { skip: !sqliteAvailable }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "proactive-gate-"));
  const path = join(directory, "store.sqlite");
  try {
    const first = new SqliteStore(path);
    await first.set("key", "value");
    assert.equal(await first.incr("counter"), 1);
    first.close();

    const second = new SqliteStore(path);
    assert.equal(await second.get("key"), "value");
    assert.equal(await second.get("counter"), "1");
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("adaptive timing never rejects; it defers and can narrow surfaces", async () => {
  const later = new Date("2026-09-04T15:00:00Z");
  const gate = createGate({
    checks: [
      checks.adaptiveTiming({ nextGoodMoment: () => later, surfacesFor: () => ["feed"] }),
      { id: "rogue", nonRejecting: true, run: () => ({ kind: "reject", reason: "should be ignored" }) },
    ],
  });
  const d = await gate.evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(d.allowed, true);
  assert.equal(d.deliverAt?.toISOString(), later.toISOString());
  assert.deepEqual(d.surfaces, ["feed"]);
  assert.equal(d.trace[1]?.outcome, "skip");
});

test("store failure fails open by default and closed on request, and the trace says which", async () => {
  const broken: Store = {
    get: async () => { throw new Error("redis down"); },
    set: async () => { throw new Error("redis down"); },
    incr: async () => { throw new Error("redis down"); },
    del: async () => { throw new Error("redis down"); },
  };
  const open = createGate({ store: broken, checks: [checks.dailyBudget({ limit: 1 })] });
  const d1 = await open.evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(d1.allowed, true);
  assert.match(d1.trace[0]?.reason ?? "", /failing open/);
  assert.equal(await open.commit(d1, { user: user(), candidate: candidate(), now: noon }), true);
  const closed = createGate({ store: broken, onStoreError: "closed", checks: [checks.dailyBudget({ limit: 1 })] });
  const d2 = await closed.evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(d2.allowed, false);
  assert.equal(d2.rejectedBy, "dailyBudget");
});

test("user surfaces filter candidate surfaces; onDecision sees every decision", async () => {
  const seen: string[] = [];
  const gate = createGate({ checks: defaultChecks(), onDecision: (d) => seen.push(`${d.candidateId}:${d.allowed}`) });
  const d = await gate.evaluate({ user: user({ surfaces: ["feed"] }), candidate: candidate({ surfaces: ["push", "feed", "voice"] }), now: noon });
  assert.deepEqual(d.surfaces, ["feed"]);
  await gate.evaluate({ user: user({ consent: false }), candidate: candidate({ id: "c2" }), now: noon });
  assert.deepEqual(seen, ["c1:true", "c2:false"]);
});

test("replay summarises a day of candidates and consumes the budget in order", async () => {
  const gate = createGate({ checks: defaultChecks({ dailyLimit: 2 }) });
  const lines = [
    JSON.stringify({ user: user(), candidate: candidate({ id: "a" }), now: noon }),
    JSON.stringify({ user: user(), candidate: candidate({ id: "b" }), now: noon }),
    JSON.stringify({ user: user(), candidate: candidate({ id: "c" }), now: noon }),
    JSON.stringify({ user: user(), candidate: candidate({ id: "d" }), now: night }),
    JSON.stringify({ user: user({ consent: false }), candidate: candidate({ id: "e" }), now: noon }),
  ];
  const decisions = await replay(lines, gate, true);
  assert.deepEqual(decisions.map((d) => d.allowed), [true, true, false, false, false]);
  const text = summarize(decisions);
  assert.match(text, /5 candidates {2}· {2}2 allowed \(40\.0%\)/);
  assert.match(text, /dailyBudget/);
  assert.match(text, /quietHours/);
  assert.match(text, /consent/);
});

test("a custom check is an ordinary object: it runs in order, reads the context, and shows in the trace", async () => {
  const weekendsOnlyHigh = {
    id: "weekendFloor",
    run: ({ now, priority }: { now: Date; priority: string }) => {
      const day = now.getUTCDay();
      if ((day === 0 || day === 6) && priority !== "high" && priority !== "critical") return { kind: "reject" as const, reason: "weekend: only high priority" };
      return { kind: "pass" as const };
    },
  };
  const gate = createGate({ checks: [checks.consent(), weekendsOnlyHigh, checks.dailyBudget({ limit: 5 })] });
  const saturday = new Date("2026-09-05T10:00:00Z");
  const d = await gate.evaluate({ user: user(), candidate: candidate(), now: saturday });
  assert.equal(d.rejectedBy, "weekendFloor");
  assert.deepEqual(d.trace.map((t) => `${t.id}:${t.outcome}`), ["consent:pass", "weekendFloor:reject"]);
  const monday = await gate.evaluate({ user: user(), candidate: candidate(), now: new Date("2026-09-07T10:00:00Z") });
  assert.equal(monday.allowed, true);
  assert.equal(monday.trace.length, 3);
});

/* ---------------------------------------------------------------- v2: policy as data */

import { readFileSync } from "node:fs";
import { compilePolicy } from "../src/index.js";
import type { Policy } from "../src/index.js";

const examplePolicy = (): Policy => JSON.parse(readFileSync(new URL("../../examples/policy.json", import.meta.url), "utf8")) as Policy;

test("policy: the example JSON compiles to thirteen checks in the written order", () => {
  const compiled = compilePolicy(examplePolicy());
  assert.equal(compiled.checks.length, 13);
  assert.deepEqual(compiled.checks.map((c) => c.id), ["killSwitch", "consent", "enabled", "mode", "snooze", "mute", "intensity", "quietHours", "trustRamp", "dismissalCooldown", "adaptiveTiming", "utilityFloor", "dailyBudget"]);
  assert.equal(compiled.onStoreError, "open");
});

test("policy: an unknown id throws and names the known ids", () => {
  assert.throws(() => compilePolicy({ specVersion: "1.0.0", checks: [{ id: "nope" }] }), /unknown check "nope"; known checks: killSwitch, consent/);
});

test("policy: a preset entry expands to its checks and an unknown preset names the known ones", () => {
  const compiled = compilePolicy({ specVersion: "1.0.0", checks: [{ preset: "usTcpa" }] });
  assert.ok(compiled.checks.length >= 1);
  assert.throws(() => compilePolicy({ specVersion: "1.0.0", checks: [{ preset: "nope" }] }), /unknown preset "nope"; known presets: lineMessagingApi/);
});

test("policy: specVersion 2.0.0 is refused, shadow marks the check", () => {
  assert.throws(() => compilePolicy({ specVersion: "2.0.0", checks: [{ id: "consent" }] }), /specVersion 2.0.0 is not supported/);
  const compiled = compilePolicy({ specVersion: "1.0.0", checks: [{ id: "consent", shadow: true }, { id: "mute" }] });
  assert.equal(compiled.checks[0]!.shadow, true);
  assert.equal(compiled.checks[1]!.shadow, undefined);
  assert.throws(() => createGate({ policy: examplePolicy(), checks: [] } as never), /either checks or policy/);
});

/* ---------------------------------------------------------------- v2: outcome model */

test("defer: snooze with defer:true stops with deferredBy and retryAt, and commit on a deferred decision is false", async () => {
  const until = "2026-09-04T12:00:00Z";
  const gate = createGate({ checks: [checks.consent(), checks.snooze({ defer: true }), checks.dailyBudget({ limit: 5 })] });
  const input = { user: user({ snoozedUntil: until }), candidate: candidate(), now: noon };
  const d = await gate.evaluate(input);
  assert.equal(d.allowed, false);
  assert.equal(d.deferredBy, "snooze");
  assert.equal(d.rejectedBy, undefined);
  assert.equal(d.retryAt?.toISOString(), new Date(until).toISOString());
  assert.deepEqual(d.trace.map((t) => `${t.id}:${t.outcome}`), ["consent:pass", "snooze:defer"]);
  assert.equal(await gate.commit(d, input), false);
  assert.match(summarize([d]), /1 deferred/);
});

test("shadow: a shadowed reject is recorded, listed in shadowed, and evaluation continues", async () => {
  const gate = createGate({ checks: [checks.consent(), { ...checks.mute(), shadow: true }, checks.dailyBudget({ limit: 5 })] });
  const d = await gate.evaluate({ user: user({ mutedTypes: ["reminder"] }), candidate: candidate(), now: noon });
  assert.equal(d.allowed, true);
  assert.deepEqual(d.shadowed, ["mute"]);
  const entry = d.trace.find((t) => t.id === "mute")!;
  assert.equal(entry.outcome, "reject");
  assert.equal(entry.shadow, true);
  assert.equal(d.trace.length, 3);
});

test("nearLimit: a daily budget of five reports 4 of 5 on the pass that reaches the threshold", async () => {
  const store = new MemoryStore();
  const gate = createGate({ checks: [checks.consent(), checks.dailyBudget({ limit: 5 })], store });
  const input = { user: user(), candidate: candidate(), now: noon };
  for (let i = 0; i < 4; i += 1) await gate.commit(await gate.evaluate({ ...input, candidate: candidate({ id: `c${i}` }) }), input);
  const d = await gate.evaluate(input);
  assert.equal(d.allowed, true);
  assert.deepEqual(d.nearLimit, [{ check: "dailyBudget", used: 4, limit: 5 }]);
});

test("hooks: before, after (with ms), finally run in order; a throwing hook reaches error and does not change the decision", async () => {
  const calls: string[] = [];
  const gate = createGate({
    checks: [checks.consent(), checks.mute()],
    hooks: {
      before: (_ctx, check) => { calls.push(`before:${check.id}`); },
      after: (_ctx, check, outcome, ms) => { calls.push(`after:${check.id}:${outcome.kind}`); assert.equal(typeof ms, "number"); if (check.id === "mute") throw new Error("boom"); },
      error: (_ctx, check, error) => { calls.push(`error:${check.id}:${(error as Error).message}`); },
      finally: (decision) => { calls.push(`finally:${decision.allowed}`); },
    },
  });
  const d = await gate.evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(d.allowed, true);
  assert.deepEqual(calls, ["before:consent", "after:consent:pass", "before:mute", "after:mute:pass", "error:mute:boom", "finally:true"]);
});

test("commit is idempotent on decision.id: the second call returns the first result without consuming again", async () => {
  const store = new MemoryStore();
  const gate = createGate({ checks: [checks.dailyBudget({ limit: 5 })], store });
  const input = { user: user(), candidate: candidate(), now: noon };
  const d = await gate.evaluate(input);
  assert.equal(await gate.commit(d, input), true);
  assert.equal(await gate.commit(d, input), true);
  assert.equal((await gate.inspect(user(), noon)).budgetUsed, 1);
  assert.match(d.id, /^u1:c1:2026-09-04T09:00:00\.000Z/);
});

/* ---------------------------------------------------------------- v2: optional checks */

test("utilityFloor: tau = cFA / (cFA + pNeed * cFN); below rejects, above passes, missing pAccept skips", async () => {
  const gate = createGate({ checks: [checks.utilityFloor({ costFalseAlarm: 1, costMissedHelp: 2 })] });
  const low = await gate.evaluate({ user: user(), candidate: candidate({ pAccept: 0.41, pNeed: 0.4 }), now: noon });
  assert.equal(low.rejectedBy, "utilityFloor");
  assert.equal(low.reason, "pAccept 0.41 < tau 0.556");
  const high = await gate.evaluate({ user: user(), candidate: candidate({ pAccept: 0.6, pNeed: 0.4 }), now: noon });
  assert.equal(high.allowed, true);
  const none = await gate.evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(none.allowed, true);
  assert.equal(none.trace[0]!.outcome, "skip");
});

test("boundedDeferral: a busy candidate is delivered at now + t*, capped at the bound; not busy passes untouched", async () => {
  const gate = createGate({ checks: [checks.boundedDeferral({ lambda: 1 / 43, interruptCost: 1, staleness: 0.0001 })] });
  const busy = await gate.evaluate({ user: user(), candidate: candidate({ busy: true }), now: noon });
  assert.equal(busy.allowed, true);
  assert.equal(busy.trace[0]!.outcome, "adjust");
  const tStar = Math.min(240, (1 / 43) / (2 * 0.0001)); // 116.28 s, under the 240 s bound
  assert.equal(busy.deliverAt?.getTime(), noon.getTime() + Math.round(tStar * 1000));
  const defaults = createGate({ checks: [checks.boundedDeferral()] });
  const d = await defaults.evaluate({ user: user(), candidate: candidate({ busy: true }), now: noon });
  assert.equal(d.deliverAt?.getTime(), busy.deliverAt?.getTime()); // the explicit values above are the defaults
  const capped = createGate({ checks: [checks.boundedDeferral({ lambda: 1 })] }); // 5000 s, so the 240 s bound wins
  const c = await capped.evaluate({ user: user(), candidate: candidate({ busy: true }), now: noon });
  assert.equal(c.deliverAt?.getTime(), noon.getTime() + 240 * 1000);
  const free = await gate.evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(free.deliverAt, undefined);
  assert.equal(free.trace[0]!.outcome, "pass");
});
