import { test } from "node:test";
import assert from "node:assert/strict";
import { checks, compilePolicy, createGate, MemoryStore } from "../src/index.js";
import type { Candidate, UserState } from "../src/index.js";

// SPEC 1.6.0 S13: a kill switch read from runtime flags. It rejects only while the named flag is false;
// an absent flag stops nothing. The existing `on` form is unchanged.

const user: UserState = { id: "u1", consent: true };
const candidate: Candidate = { id: "c1", type: "reminder" };
const now = new Date("2026-09-04T12:00:00Z");
const decide = (flags: Record<string, boolean> | undefined, list = [checks.killSwitchFlag("proactiveEnabled")]) =>
  createGate({ checks: list, store: new MemoryStore() }).evaluate({ user, candidate, now, ...(flags ? { flags } : {}) });

test("S13: a named flag that is false rejects with a kill switch reason", async () => {
  const decision = await decide({ proactiveEnabled: false });
  assert.equal(decision.rejectedBy, "killSwitch");
  assert.match(decision.reason ?? "", /kill switch/);
});

test("S13: a named flag that is true passes", async () => {
  assert.equal((await decide({ proactiveEnabled: true })).allowed, true);
});

test("S13: an absent flag, or no flags at all, stops nothing", async () => {
  assert.equal((await decide({})).allowed, true);
  assert.equal((await decide(undefined)).allowed, true);
});

test("S13: only the named flag is read", async () => {
  assert.equal((await decide({ somethingElse: false })).allowed, true);
});

test("S13: the policy form {id, flag} reads the flag on every evaluation", async () => {
  const gate = createGate({ policy: { specVersion: "1.0.0", checks: [{ id: "killSwitch", flag: "proactiveEnabled" }] }, store: new MemoryStore() });
  assert.equal((await gate.evaluate({ user, candidate, now, flags: { proactiveEnabled: false } })).rejectedBy, "killSwitch");
  assert.equal((await gate.evaluate({ user, candidate, now, flags: { proactiveEnabled: true } })).allowed, true);
});

test("S13: the policy form {id, on} is unchanged by flags", async () => {
  const gate = createGate({ policy: { specVersion: "1.0.0", checks: [{ id: "killSwitch", on: true }] }, store: new MemoryStore() });
  assert.equal((await gate.evaluate({ user, candidate, now, flags: { proactiveEnabled: true } })).rejectedBy, "killSwitch");
});

test("S13: giving both on and flag is refused when the policy compiles", () => {
  assert.throws(() => compilePolicy({ specVersion: "1.0.0", checks: [{ id: "killSwitch", on: true, flag: "proactiveEnabled" }] }), /not both/);
});
