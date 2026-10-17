import { createGate, defaultChecks, MemoryStore } from "proactive-gate";

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const now = new Date("2026-09-04T09:00:00Z");
const user = {
  id: "runtime-smoke",
  consent: true,
  proactiveEnabled: true,
  mode: "normal",
  intensity: "normal",
  timezone: "Europe/Istanbul",
  quietHours: { start: "22:00", end: "08:00" },
  createdAt: "2026-01-01T00:00:00Z",
};
const candidate = { id: "first", type: "reminder", priority: "normal", surfaces: ["push"] };
const checks = defaultChecks({ dailyLimit: 1 });
const gate = createGate({ store: new MemoryStore(() => now.getTime()), checks });
const input = { user, candidate, now };
const decision = await gate.evaluate(input);

expect(decision.allowed === true, "the daytime decision should be allowed");
expect(decision.surfaces.length === 1 && decision.surfaces[0] === "push", "the push surface should be preserved");
expect(decision.trace.length === checks.length, "every default check should run");
expect(decision.trace.every((entry) => entry.outcome === "pass"), "no default check should throw or skip");
expect(await gate.commit(decision, input), "the allowed decision should commit");
expect((await gate.inspect(user, now)).budgetUsed === 1, "commit should consume the MemoryStore budget");

const next = await gate.evaluate({ ...input, candidate: { ...candidate, id: "second" } });
expect(next.allowed === false && next.rejectedBy === "dailyBudget", "the next decision should hit the daily budget");
const noConsent = await gate.evaluate({ ...input, user: { ...user, consent: false } });
expect(noConsent.allowed === false && noConsent.rejectedBy === "consent", "consent should reject before the budget");
console.log("runtime smoke: allowed, committed, budget rejected, consent rejected");
