import { test } from "node:test";
import assert from "node:assert/strict";
import { createGate, MemoryStore, presets, compilePolicy, KNOWN_CHECKS } from "../src/index.js";
import type { Candidate, UserState } from "../src/index.js";

const user = (o: Partial<UserState> = {}): UserState => ({ id: "u1", consent: true, timezone: "Europe/Istanbul", ...o });
const candidate = (o: Partial<Candidate> = {}): Candidate => ({ id: "c1", type: "reminder", ...o });

test("every preset has sources, a note, and builds an ordered list", () => {
  for (const [name, preset] of Object.entries(presets)) {
    assert.ok(preset.sources.length >= 1, `${name} has no source`);
    assert.ok(preset.sources.every((s) => s.startsWith("https://")), `${name} source is not a URL`);
    assert.ok(preset.note.length > 20, `${name} has no note`);
    const list = preset();
    assert.ok(list.length >= 1, `${name} builds nothing`);
    assert.ok(list.every((c) => typeof c.id === "string" && typeof c.run === "function"), `${name} is not a check list`);
  }
  assert.equal(Object.keys(presets).length, 14);
});

test("lineMessagingApi maps plans to monthly budgets and rejects unknown plans", () => {
  const [, budget] = presets.lineMessagingApi!({ plan: "light" }) as Array<{ limit?: number }>;
  assert.equal(budget!.limit, 5000);
  assert.throws(() => presets.lineMessagingApi!({ plan: "gold" }), /unknown plan/);
});

test("usTcpa rejects at 21:30 in the user's zone and passes at 09:00", async () => {
  const gate = createGate({ checks: presets.usTcpa!() });
  const u = user({ timezone: "America/Chicago" });
  assert.equal((await gate.evaluate({ user: u, candidate: candidate(), now: new Date("2026-09-05T02:30:00Z") })).rejectedBy, "window:tcpa");
  assert.equal((await gate.evaluate({ user: u, candidate: candidate(), now: new Date("2026-09-04T14:00:00Z") })).allowed, true);
});

test("euEprivacy: soft opt-in for existing customers, consent otherwise", async () => {
  const gate = createGate({ checks: presets.euEprivacy!() });
  assert.equal((await gate.evaluate({ user: user(), candidate: candidate() })).rejectedBy, "consent:marketing");
  assert.equal((await gate.evaluate({ user: user({ existingCustomer: true }), candidate: candidate() })).allowed, true);
  assert.equal((await gate.evaluate({ user: user({ consents: { marketing: true } }), candidate: candidate() })).allowed, true);
});

test("wechatCustomerService: 48 h window from the last inbound message, five messages", async () => {
  const store = new MemoryStore();
  const gate = createGate({ store, checks: presets.wechatCustomerService!() });
  const now = new Date("2026-09-04T09:00:00Z");
  const fresh = user({ lastInboundAt: "2026-09-04T08:00:00Z" });
  for (let i = 0; i < 5; i++) {
    const d = await gate.evaluate({ user: fresh, candidate: candidate({ id: `c${i}` }), now });
    assert.equal(d.allowed, true, `message ${i + 1}`);
    assert.equal(await gate.commit(d, { user: fresh, candidate: candidate({ id: `c${i}` }), now }), true);
  }
  assert.equal((await gate.evaluate({ user: fresh, candidate: candidate({ id: "c9" }), now })).rejectedBy, "windowBudget");
  const stale = user({ lastInboundAt: "2026-09-01T08:00:00Z" });
  assert.equal((await gate.evaluate({ user: stale, candidate: candidate(), now })).rejectedBy, "recentInteraction");
  assert.equal((await gate.evaluate({ user: user(), candidate: candidate(), now })).rejectedBy, "recentInteraction");
});

test("wecomAppMessage: 30 a minute, consumed at commit", async () => {
  const gate = createGate({ checks: presets.wecomAppMessage!() });
  const now = new Date("2026-09-04T09:00:00Z");
  for (let i = 0; i < 30; i++) {
    const input = { user: user(), candidate: candidate({ id: `c${i}` }), now };
    const d = await gate.evaluate(input);
    assert.equal(d.allowed, true);
    assert.equal(await gate.commit(d, input), true);
  }
  assert.equal((await gate.evaluate({ user: user(), candidate: candidate({ id: "c31" }), now })).rejectedBy, "rate:30/min");
});

test("policies: the example compiles in order, presets expand, unknown ids and versions throw, shadow flags", () => {
  const options = compilePolicy({ specVersion: "1.0.0", checks: [{ id: "consent" }, { preset: "krNetworkAct50" }, { id: "dailyBudget", limit: 2, shadow: true }] });
  assert.deepEqual(options.checks.map((c) => c.id), ["consent", "consent:ad", "consent:night", "dailyBudget"]);
  assert.equal(options.checks[3]!.shadow, true);
  assert.throws(() => compilePolicy({ specVersion: "1.0.0", checks: [{ id: "nope" }] }), /unknown check "nope"; known checks: killSwitch/);
  assert.throws(() => compilePolicy({ specVersion: "1.0.0", checks: [{ preset: "nope" }] }), /unknown preset "nope"/);
  assert.throws(() => compilePolicy({ specVersion: "2.0.0", checks: [{ id: "consent" }] }), /not supported/);
  assert.throws(() => createGate({ policy: { specVersion: "1.0.0", checks: [{ id: "consent" }] }, checks: [] } as never), /either checks or policy/);
  assert.ok(Object.keys(KNOWN_CHECKS).length >= 20);
});
