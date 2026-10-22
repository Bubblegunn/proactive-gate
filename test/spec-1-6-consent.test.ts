import { test } from "node:test";
import assert from "node:assert/strict";
import { checks, createGate, MemoryStore } from "../src/index.js";
import type { Candidate, UserState } from "../src/index.js";

// SPEC 1.6.0 S3: when consentUnknown is true, each surface still on the table is kept only when its
// fail mode is "open" (the surface's own entry, else default, else closed).

const user = (overrides: Partial<UserState> = {}): UserState => ({ id: "u1", consent: true, consentUnknown: true, ...overrides });
const candidate = (surfaces: string[]): Candidate => ({ id: "c1", type: "reminder", surfaces });
const now = new Date("2026-09-04T12:00:00Z");
const decide = (u: UserState, c: Candidate, failMode?: Record<string, "open" | "closed">) =>
  createGate({ checks: [checks.consent(failMode ? { failMode } : {})], store: new MemoryStore() }).evaluate({ user: u, candidate: c, now });

test("S3: unknown consent with no fail mode rejects, whatever the surfaces", async () => {
  const decision = await decide(user(), candidate(["push", "feed"]));
  assert.equal(decision.allowed, false);
  assert.equal(decision.rejectedBy, "consent");
  assert.match(decision.reason ?? "", /consent could not be determined/);
});

test("S3: a surface whose fail mode is open is kept and the others are dropped", async () => {
  const decision = await decide(user(), candidate(["push", "feed"]), { feed: "open" });
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.surfaces, ["feed"]);
  assert.equal(decision.trace[0]?.outcome, "adjust");
});

test("S3: default open keeps every surface", async () => {
  const decision = await decide(user(), candidate(["push", "feed"]), { default: "open" });
  assert.deepEqual(decision.surfaces, ["push", "feed"]);
});

test("S3: a surface with no entry takes the default, which is closed", async () => {
  const decision = await decide(user(), candidate(["email", "feed"]), { feed: "open" });
  assert.deepEqual(decision.surfaces, ["feed"]);
});

test("S3: when no surface stays open, the candidate is rejected", async () => {
  const decision = await decide(user(), candidate(["push"]), { feed: "open" });
  assert.equal(decision.rejectedBy, "consent");
});

test("S3: a known refusal still reads as a refusal, not as unknown", async () => {
  const decision = await decide(user({ consent: false, consentUnknown: false }), candidate(["push", "feed"]), { default: "open" });
  assert.equal(decision.rejectedBy, "consent");
  assert.match(decision.reason ?? "", /has not consented/);
});

test("S3: a known consent passes and keeps every surface whatever the fail modes say", async () => {
  const decision = await decide(user({ consentUnknown: false }), candidate(["push", "feed"]), { push: "closed" });
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.surfaces, ["push", "feed"]);
});
