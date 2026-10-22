import { test } from "node:test";
import assert from "node:assert/strict";
import { createGate, MemoryStore } from "../src/index.js";
import type { Candidate, CheckContext, UserState } from "../src/index.js";

// SPEC 1.6.0 S1: the optional fields exist on the types and a check sees them unchanged.

test("S1: every 1.6.0 user field is typed and reaches a check unchanged", async () => {
  const user: UserState = {
    id: "u1",
    consent: true,
    deviceTimezone: "America/New_York",
    consentUnknown: false,
    crisisUntil: null,
    hourStats: { "9": { acted: 2, dismissed: 1 } },
    tier: "pro",
    dailyLimit: 4,
  };
  let seen: UserState | undefined;
  const probe = { id: "probe", run: (ctx: CheckContext) => { seen = ctx.user; return { kind: "pass" as const }; } };
  await createGate({ checks: [probe], store: new MemoryStore() }).evaluate({ user, candidate: { id: "c1", type: "reminder" }, now: new Date("2026-09-04T12:00:00Z") });
  assert.deepEqual(seen, user);
});

test("S1: every 1.6.0 candidate field is typed and reaches a check unchanged", async () => {
  const candidate: Candidate = {
    id: "c1",
    type: "reminder",
    requested: true,
    kind: "commitment",
    transactional: false,
    freshUntil: "2026-09-05T00:00:00Z",
    createdAt: new Date("2026-09-04T10:00:00Z"),
    evidence: { dataPoints: 7, confidence: 0.9, newSinceLast: true },
  };
  let seen: unknown;
  const probe = { id: "probe", run: (ctx: CheckContext) => { seen = ctx.candidate; return { kind: "pass" as const }; } };
  await createGate({ checks: [probe], store: new MemoryStore() }).evaluate({ user: { id: "u1", consent: true }, candidate, now: new Date("2026-09-04T12:00:00Z") });
  assert.deepEqual(seen, candidate);
});

test("S1: EvaluateInput.flags is passed to every check as ctx.flags", async () => {
  let seen: Record<string, boolean> | undefined;
  const probe = { id: "probe", run: (ctx: CheckContext) => { seen = ctx.flags; return { kind: "pass" as const }; } };
  const flags = { proactiveEnabled: false };
  await createGate({ checks: [probe], store: new MemoryStore() }).evaluate({ user: { id: "u1", consent: true }, candidate: { id: "c1", type: "reminder" }, now: new Date("2026-09-04T12:00:00Z"), flags });
  assert.deepEqual(seen, flags);
});

test("S1: a candidate with no flags sees no flags, not an invented object", async () => {
  let seen: Record<string, boolean> | undefined = { sentinel: true };
  const probe = { id: "probe", run: (ctx: CheckContext) => { seen = ctx.flags; return { kind: "pass" as const }; } };
  await createGate({ checks: [probe], store: new MemoryStore() }).evaluate({ user: { id: "u1", consent: true }, candidate: { id: "c1", type: "reminder" }, now: new Date("2026-09-04T12:00:00Z") });
  assert.equal(seen, undefined);
});
