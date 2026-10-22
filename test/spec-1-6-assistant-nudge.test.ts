import { test } from "node:test";
import assert from "node:assert/strict";
import { compilePolicy, createGate, MemoryStore, presets } from "../src/index.js";
import type { Candidate, EvaluateInput, UserState } from "../src/index.js";

// SPEC 1.6.0 S14. The assistantNudge preset expands, in order, to the checks of an assistant that messages users
// proactively: the kill switch, crisis quiet, consent, marketing consent, and the rest of the 1.6.0 checks.

const now = new Date("2026-09-04T12:00:00Z");
const user = (o: Partial<UserState> = {}): UserState => ({ id: "u1", consent: true, consents: { marketing: true }, deviceTimezone: "Europe/Istanbul", createdAt: "2026-07-01T00:00:00Z", ...o });
const candidate = (o: Partial<Candidate> = {}): Candidate => ({ id: "c1", type: "insight", ...o });
const input = (u: UserState, c: Candidate, flags?: Record<string, boolean>): EvaluateInput => ({ user: u, candidate: c, now, ...(flags ? { flags } : {}) });
const nudge = (options?: Record<string, unknown>) => presets.assistantNudge!(options);

test("S14: the preset expands to the sixteen checks in the order the spec gives", () => {
  assert.deepEqual(
    nudge().map((c) => c.id),
    ["killSwitch", "crisisQuiet", "consent", "consent:marketing", "enabled", "mode", "snooze", "mute", "quietHours", "trustRamp", "dismissalCooldown", "freshness", "silence", "dedupe", "deadHours", "dailyBudget"],
  );
});

test("S14: the default daily limit is three, and dailyLimit sets it", () => {
  const limitOf = (checkList: ReturnType<typeof nudge>) => (checkList.at(-1) as unknown as { limit: number }).limit;
  assert.equal(limitOf(nudge()), 3);
  assert.equal(limitOf(nudge({ dailyLimit: 7 })), 7);
  assert.throws(() => nudge({ dailyLimit: -1 }), /dailyLimit/);
});

test("S14: exemptTypes reaches the dismissal cooldown", async () => {
  const store = new MemoryStore();
  const gate = createGate({ checks: nudge({ exemptTypes: ["digest"] }), store });
  for (const days of [1, 2, 3]) await gate.record(user(), { type: "digest" }, "dismissed", new Date(now.getTime() - days * 86_400_000));
  assert.equal((await gate.evaluate(input(user(), candidate({ type: "digest" })))).allowed, true);
  for (const days of [1, 2, 3]) await gate.record(user(), { type: "reminder" }, "dismissed", new Date(now.getTime() - days * 86_400_000));
  assert.equal((await gate.evaluate(input(user(), candidate({ type: "reminder" })))).rejectedBy, "dismissalCooldown");
});

test("S14: missing marketing consent blocks a non-transactional candidate and lets a transactional one through", async () => {
  const gate = createGate({ checks: nudge(), store: new MemoryStore() });
  const u = user({ consents: {} });
  assert.equal((await gate.evaluate(input(u, candidate()))).rejectedBy, "consent:marketing");
  const receipt = await gate.evaluate(input(u, candidate({ transactional: true })));
  assert.equal(receipt.trace.find((t) => t.id === "consent:marketing")?.outcome, "pass");
});

test("S14: a reminder the user set up passes without marketing consent; a requested notice passes too; an inferred nudge does not", async () => {
  const gate = createGate({ checks: nudge(), store: new MemoryStore() });
  const noMarketing = user({ consents: {} });
  assert.equal((await gate.evaluate(input(noMarketing, candidate({ kind: "commitment" })))).allowed, true);
  assert.equal((await gate.evaluate(input(noMarketing, candidate({ requested: true, priority: "low" })))).allowed, true);
  assert.equal((await gate.evaluate(input(noMarketing, candidate()))).rejectedBy, "consent:marketing");
});

test("S14: a user with no zone is rejected, because the preset refuses a missing zone", async () => {
  const gate = createGate({ checks: nudge(), store: new MemoryStore() });
  const zoneless: UserState = { id: "u1", consent: true, consents: { marketing: true }, createdAt: "2026-07-01T00:00:00Z" };
  const decision = await gate.evaluate(input(zoneless, candidate()));
  assert.equal(decision.rejectedBy, "quietHours");
  assert.match(decision.reason ?? "", /time zone/);
});

test("S14: the kill switch flag stops everything before crisis quiet is read", async () => {
  const gate = createGate({ checks: nudge(), store: new MemoryStore() });
  const decision = await gate.evaluate(input(user(), candidate(), { proactiveEnabled: false }));
  assert.equal(decision.rejectedBy, "killSwitch");
  assert.deepEqual(decision.trace.map((t) => t.id), ["killSwitch"]);
});

test("S14: a policy of { preset: assistantNudge } compiles and runs through createGate with MemoryStore", async () => {
  const gate = createGate({ policy: { specVersion: "1.6.0", checks: [{ preset: "assistantNudge", dailyLimit: 1 }] }, store: new MemoryStore() });
  const first = await gate.evaluate(input(user(), candidate({ priority: "high" })));
  assert.equal(first.allowed, true);
  assert.equal(await gate.commit(first, input(user(), candidate({ priority: "high" }))), true);
  const second = await gate.evaluate(input(user(), candidate({ id: "c2", priority: "high" })));
  assert.equal(second.rejectedBy, "dailyBudget");
});

test("S14: a requested candidate passes the ramp on a new account", async () => {
  const gate = createGate({ checks: nudge(), store: new MemoryStore() });
  const fresh = user({ createdAt: "2026-09-04T11:00:00Z" });
  assert.equal((await gate.evaluate(input(fresh, candidate({ priority: "low" })))).rejectedBy, "trustRamp");
  assert.equal((await gate.evaluate(input(fresh, candidate({ priority: "low", requested: true })))).allowed, true);
});

test("S14: the preset's sources are the four official pages, and it has a note", () => {
  assert.equal(presets.assistantNudge!.sources.length, 4);
  assert.ok(presets.assistantNudge!.sources.every((s) => s.startsWith("https://")));
  assert.ok(presets.assistantNudge!.note.length > 20);
  assert.doesNotThrow(() => compilePolicy({ specVersion: "1.6.0", checks: [{ preset: "assistantNudge" }] }));
});
