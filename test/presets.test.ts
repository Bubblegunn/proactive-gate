import { test } from "node:test";
import assert from "node:assert/strict";
import { createGate, MemoryStore, presets, compilePolicy, KNOWN_CHECKS, checks } from "../src/index.js";
import type { Candidate, CheckContext, Priority, UserState } from "../src/index.js";

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
  assert.equal(Object.keys(presets).length, 18);
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

test("inTcccp: promotional consent, and each default-off band needs its own opt-in", async () => {
  const gate = createGate({ checks: presets.inTcccp!() });
  const kolkata = (consents: Record<string, boolean>) => user({ timezone: "Asia/Kolkata", consents });
  const at = (iso: string) => gate.evaluate({ user: kolkata({ promotional: true }), candidate: candidate(), now: new Date(iso) });
  assert.equal((await gate.evaluate({ user: kolkata({}), candidate: candidate(), now: new Date("2026-09-04T06:30:00Z") })).rejectedBy, "consent:promotional");
  assert.equal((await at("2026-09-04T06:30:00Z")).allowed, true); // 12:00 IST, inside the default-on window
  assert.equal((await at("2026-09-04T17:00:00Z")).rejectedBy, "consent:band21to24"); // 22:30 IST
  assert.equal((await at("2026-09-04T03:30:00Z")).rejectedBy, "consent:band08to10"); // 09:00 IST
  const optedIn = user({ timezone: "Asia/Kolkata", consents: { promotional: true, band21to24: true } });
  assert.equal((await gate.evaluate({ user: optedIn, candidate: candidate(), now: new Date("2026-09-04T17:00:00Z") })).allowed, true);
  const partial = user({ timezone: "Asia/Kolkata", consents: { promotional: true, band06to08: true } });
  assert.equal((await gate.evaluate({ user: partial, candidate: candidate(), now: new Date("2026-09-04T22:30:00Z") })).rejectedBy, "consent:band00to06"); // 04:00 IST: opting into one band does not open another
});

test("brLgpd: marketing consent for everyone, and a minor needs it from a parent", async () => {
  const gate = createGate({ checks: presets.brLgpd!() });
  const at = (iso: string) => new Date(iso);
  assert.equal((await gate.evaluate({ user: user(), candidate: candidate(), now: at("2026-09-04T14:00:00Z") })).rejectedBy, "consent:marketing");
  assert.equal((await gate.evaluate({ user: user({ consents: { marketing: true } }), candidate: candidate(), now: at("2026-09-04T14:00:00Z") })).allowed, true);
  // no soft opt-in: an existing customer without marketing consent still rejects
  assert.equal((await gate.evaluate({ user: user({ existingCustomer: true }), candidate: candidate(), now: at("2026-09-04T14:00:00Z") })).rejectedBy, "consent:marketing");
  assert.equal((await gate.evaluate({ user: user({ minor: true, consents: { marketing: true } }), candidate: candidate(), now: at("2026-09-04T14:00:00Z") })).rejectedBy, "consent:parental");
  const childOk = user({ minor: true, consents: { marketing: true, parental: true } });
  assert.equal((await gate.evaluate({ user: childOk, candidate: candidate(), now: at("2026-09-04T14:00:00Z") })).allowed, true);
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

test("whatsappBusiness: opt-in always, free-form only inside the 24 h window, template skips it", async () => {
  const gate = createGate({ checks: presets.whatsappBusiness!() });
  const optedIn = (o: Partial<UserState> = {}) => user({ consents: { whatsappOptIn: true }, ...o });
  const now = new Date("2026-09-04T12:00:00Z");
  assert.equal((await gate.evaluate({ user: user(), candidate: candidate(), now })).rejectedBy, "consent:whatsappOptIn");
  assert.equal((await gate.evaluate({ user: optedIn(), candidate: candidate(), now })).rejectedBy, "recentInteraction");
  const stale = optedIn({ lastInboundAt: "2026-09-03T11:30:00Z" }); // 24.5 h ago
  assert.equal((await gate.evaluate({ user: stale, candidate: candidate(), now })).rejectedBy, "recentInteraction");
  const fresh = optedIn({ lastInboundAt: "2026-09-04T10:00:00Z" });
  assert.equal((await gate.evaluate({ user: fresh, candidate: candidate(), now })).allowed, true);
  const tpl = createGate({ checks: presets.whatsappBusiness!({ template: true }) });
  assert.equal((await tpl.evaluate({ user: optedIn(), candidate: candidate(), now })).allowed, true); // approved templates go outside the window
  assert.equal((await tpl.evaluate({ user: user(), candidate: candidate(), now })).rejectedBy, "consent:whatsappOptIn");
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

test("allowedWindow reports when the window next opens, across daylight-saving changes", async () => {
  const gate = createGate({ checks: presets.usTcpa!() });
  const ny = user({ timezone: "America/New_York" });
  const nextAt = async (iso: string) => (await gate.evaluate({ user: ny, candidate: candidate(), now: new Date(iso) })).nextAllowedAt?.toISOString();
  assert.equal(await nextAt("2026-03-08T06:30:00Z"), "2026-03-08T12:00:00.000Z"); // spring forward night: 01:30 EST
  assert.equal(await nextAt("2026-11-01T06:30:00Z"), "2026-11-01T13:00:00.000Z"); // autumn, second 01:30 EST
  assert.equal(await nextAt("2026-06-16T01:00:00Z"), "2026-06-16T12:00:00.000Z"); // 21:00 EDT
});

test("allowedWindow: a window that opens inside a spring-forward gap resolves to the first minute that exists", async () => {
  const gate = createGate({ checks: [checks.allowedWindow({ start: "02:30", end: "09:00", timezone: "America/New_York" })] });
  const d = await gate.evaluate({ user: user(), candidate: candidate(), now: new Date("2026-03-08T06:00:00Z") }); // 01:00 EST
  assert.equal(d.nextAllowedAt?.toISOString(), "2026-03-08T07:00:00.000Z"); // 03:00 EDT
});

test("allowedWindow: a zone with a 45-minute offset opens at its own local 08:00", async () => {
  const gate = createGate({ checks: [checks.allowedWindow({ start: "08:00", end: "21:00", timezone: "Asia/Kathmandu" })] });
  const d = await gate.evaluate({ user: user(), candidate: candidate(), now: new Date("2026-06-16T15:15:00Z") }); // 21:00 local
  assert.equal(d.nextAllowedAt?.toISOString(), "2026-06-17T02:15:00.000Z"); // 08:00 local the next day
});

test("allowedWindow.nextAllowedAt: a priority at or above the floor never waits for the window", async () => {
  const daytime = checks.allowedWindow({ start: "08:00", end: "21:00", timezone: "Europe/Istanbul", priorityFloor: "high" });
  const ctx = (priority: Priority): CheckContext => ({ user: user(), candidate: candidate(), now: new Date("2026-06-16T01:00:00Z"), priority, store: new MemoryStore(), surfaces: [] }); // 04:00 local, outside the window
  assert.equal(await daytime.nextAllowedAt!(ctx("critical")), null);
  assert.equal(await daytime.nextAllowedAt!(ctx("high")), null);
  assert.equal((await daytime.nextAllowedAt!(ctx("normal")))?.toISOString(), "2026-06-16T05:00:00.000Z"); // 08:00 local
});

test("kakaoBrandMessage and krNetworkAct50 report their next instant of sending", async () => {
  const kakao = createGate({ checks: presets.kakaoBrandMessage!() });
  const kakaoDecision = await kakao.evaluate({ user: user({ timezone: "Asia/Seoul", consents: { ad: true } }), candidate: candidate(), now: new Date("2026-06-15T11:50:00Z") }); // 20:50 KST
  assert.equal(kakaoDecision.rejectedBy, "window:kakao");
  assert.equal(kakaoDecision.nextAllowedAt?.toISOString(), "2026-06-15T23:00:00.000Z");

  const kr = createGate({ checks: presets.krNetworkAct50!() });
  const krDecision = await kr.evaluate({ user: user({ timezone: "Asia/Seoul", consents: { ad: true } }), candidate: candidate(), now: new Date("2026-06-15T13:00:00Z") }); // 22:00 KST, no night consent
  assert.equal(krDecision.rejectedBy, "consent:night");
  assert.equal(krDecision.nextAllowedAt?.toISOString(), "2026-06-15T23:00:00.000Z"); // the night consent stops applying at 08:00 KST
});

test("requiresConsent without a window never says when it will stop rejecting", async () => {
  const gate = createGate({ checks: [checks.requiresConsent({ name: "ad" })] });
  const d = await gate.evaluate({ user: user({ timezone: "Asia/Seoul" }), candidate: candidate(), now: new Date("2026-06-15T13:00:00Z") });
  assert.equal(d.rejectedBy, "consent:ad");
  assert.equal(d.nextAllowedAt, undefined);
});
