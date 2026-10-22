import { test } from "node:test";
import assert from "node:assert/strict";
import { checks, createGate, MemoryStore, compilePolicy } from "../src/index.js";
import type { Candidate, EvaluateInput, UserState } from "../src/index.js";

// SPEC 1.6.0 S6 and S7. dismissalCooldown can exempt listed candidate types. requiresConsent can let a
// transactional candidate (one the user's own action caused, such as a receipt) through without consent.

const now = new Date("2026-09-04T12:00:00Z");
const user = (o: Partial<UserState> = {}): UserState => ({ id: "u1", consent: true, createdAt: "2026-07-01T00:00:00Z", ...o });
const candidate = (o: Partial<Candidate> = {}): Candidate => ({ id: "c1", type: "reminder", ...o });
const input = (u: UserState, c: Candidate): EvaluateInput => ({ user: u, candidate: c, now });

const silenced = async (gate: ReturnType<typeof createGate>, type: string) => {
  for (const days of [1, 2, 3]) await gate.record(user(), { type }, "dismissed", new Date(now.getTime() - days * 86_400_000));
};

test("S6: a type listed in exemptTypes passes after three dismissals", async () => {
  const gate = createGate({ checks: [checks.dismissalCooldown({ exemptTypes: ["digest"] })], store: new MemoryStore() });
  await silenced(gate, "digest");
  const decision = await gate.evaluate(input(user(), candidate({ type: "digest" })));
  assert.equal(decision.allowed, true);
});

test("S6: a type not listed is still silenced after three dismissals", async () => {
  const gate = createGate({ checks: [checks.dismissalCooldown({ exemptTypes: ["digest"] })], store: new MemoryStore() });
  await silenced(gate, "reminder");
  assert.equal((await gate.evaluate(input(user(), candidate({ type: "reminder" })))).rejectedBy, "dismissalCooldown");
});

test("S6: with no exemptTypes the same type is silenced", async () => {
  const gate = createGate({ checks: [checks.dismissalCooldown()], store: new MemoryStore() });
  await silenced(gate, "digest");
  assert.equal((await gate.evaluate(input(user(), candidate({ type: "digest" })))).rejectedBy, "dismissalCooldown");
});

test("S6: an exempt type passes with a reason that names the exemption", async () => {
  const gate = createGate({ checks: [checks.dismissalCooldown({ exemptTypes: ["digest"] })], store: new MemoryStore() });
  await silenced(gate, "digest");
  const decision = await gate.evaluate(input(user(), candidate({ type: "digest" })));
  assert.match(decision.trace[0]?.reason ?? "", /exempt/);
});

test("S6: exemptTypes is read from a JSON policy", async () => {
  const gate = createGate({ policy: { specVersion: "1.0.0", checks: [{ id: "dismissalCooldown", exemptTypes: ["digest"] }] }, store: new MemoryStore() });
  await silenced(gate, "digest");
  assert.equal((await gate.evaluate(input(user(), candidate({ type: "digest" })))).allowed, true);
});

test("S7: a transactional candidate passes requiresConsent without consent, with a reason that says so", async () => {
  const gate = createGate({ checks: [checks.requiresConsent({ name: "marketing", exemptTransactional: true })], store: new MemoryStore() });
  const decision = await gate.evaluate(input(user(), candidate({ transactional: true })));
  assert.equal(decision.allowed, true);
  assert.match(decision.trace[0]?.reason ?? "", /transactional/);
});

test("S7: a requested candidate passes requiresConsent without the consent, with a reason that says not promotional", async () => {
  const gate = createGate({ checks: [checks.requiresConsent({ name: "marketing", exemptTransactional: true })], store: new MemoryStore() });
  const decision = await gate.evaluate(input(user(), candidate({ requested: true })));
  assert.equal(decision.allowed, true);
  assert.match(decision.trace[0]?.reason ?? "", /requested.*not promotional/);
});

test("S7: a commitment passes requiresConsent without the consent, with a reason that says not promotional", async () => {
  const gate = createGate({ checks: [checks.requiresConsent({ name: "marketing", exemptTransactional: true })], store: new MemoryStore() });
  const decision = await gate.evaluate(input(user(), candidate({ kind: "commitment" })));
  assert.equal(decision.allowed, true);
  assert.match(decision.trace[0]?.reason ?? "", /commitment.*not promotional/);
});

test("S7: a support candidate is not exempt and still needs the consent", async () => {
  const gate = createGate({ checks: [checks.requiresConsent({ name: "marketing", exemptTransactional: true })], store: new MemoryStore() });
  assert.equal((await gate.evaluate(input(user(), candidate({ kind: "support" })))).rejectedBy, "consent:marketing");
});

test("S7: a candidate that is not transactional, requested or a commitment still needs the consent", async () => {
  const gate = createGate({ checks: [checks.requiresConsent({ name: "marketing", exemptTransactional: true })], store: new MemoryStore() });
  assert.equal((await gate.evaluate(input(user(), candidate()))).rejectedBy, "consent:marketing");
});

test("S7: without exemptTransactional a transactional candidate still needs the consent", async () => {
  const gate = createGate({ checks: [checks.requiresConsent({ name: "marketing" })], store: new MemoryStore() });
  assert.equal((await gate.evaluate(input(user(), candidate({ transactional: true })))).rejectedBy, "consent:marketing");
});

test("S7: the exemption covers only the consent it is set on", async () => {
  const gate = createGate({ policy: { specVersion: "1.0.0", checks: [{ id: "requiresConsent", name: "marketing", exemptTransactional: true }, { id: "requiresConsent", name: "newsletter" }] }, store: new MemoryStore() });
  const decision = await gate.evaluate(input(user(), candidate({ transactional: true })));
  assert.equal(decision.rejectedBy, "consent:newsletter");
  assert.deepEqual(decision.trace.map((t) => t.id), ["consent:marketing", "consent:newsletter"]);
});

test("S7: exemptTransactional is accepted by a JSON policy and compiles", () => {
  assert.doesNotThrow(() => compilePolicy({ specVersion: "1.0.0", checks: [{ id: "requiresConsent", name: "marketing", exemptTransactional: true }] }));
});
