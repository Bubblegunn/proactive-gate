/**
 * A LangGraph graph with a "notify" node. Before the node fires the notification
 * tool it asks the gate; a rejection ends the run with the reason in state, a
 * deferral records deliverAt, and an allow consumes one unit of the daily budget
 * right before the tool call. The graph knows nothing about consent, quiet hours,
 * the trust ramp or the budget; the gate holds all of it.
 *
 * Run with: npx tsx examples/langgraph.ts   (needs @langchain/langgraph)
 */
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { createGate, defaultChecks, MemoryStore } from "proactive-gate";
import type { Candidate, UserState } from "proactive-gate";

const gate = createGate({
  store: new MemoryStore(), // RedisStore(client) in production
  checks: defaultChecks({ dailyLimit: 3, quietHoursFloor: "high" }),
});

const user: UserState = {
  id: "ayse",
  consent: true,
  proactiveEnabled: true,
  mode: "normal",
  intensity: "normal",
  timezone: "Europe/Istanbul",
  quietHours: { start: "22:00", end: "08:00" },
  createdAt: "2026-06-01T00:00:00Z",
};

const State = Annotation.Root({
  candidate: Annotation<Candidate | null>({ reducer: (_a, b) => b, default: () => null }),
  outcome: Annotation<string>({ reducer: (_a, b) => b, default: () => "" }),
});

// Replace with your model call: the node that decides whether there is anything worth saying.
async function think() {
  return { candidate: { id: crypto.randomUUID(), type: "insight", priority: "normal" as const, surfaces: ["push", "feed"], payload: "Your 15:00 meeting moved to 15:30." } };
}

async function notify(state: typeof State.State) {
  const candidate = state.candidate;
  if (!candidate) return { outcome: "nothing to say" };
  const decision = await gate.evaluate({ user, candidate });
  if (!decision.allowed) return { outcome: `silent: ${decision.rejectedBy} (${decision.reason})` };
  if (decision.deliverAt) return { outcome: `deferred to ${decision.deliverAt.toISOString()}` };
  if (!(await gate.commit(decision, { user, candidate }))) return { outcome: "silent: budget consumed by another instance" };
  await sendNotification(decision.surfaces, candidate.payload);
  return { outcome: `sent on ${decision.surfaces[0]}` };
}

async function sendNotification(surfaces: string[], payload: unknown) {
  console.log(`send on ${surfaces[0]}:`, payload);
}

const graph = new StateGraph(State)
  .addNode("think", think)
  .addNode("notify", notify)
  .addEdge(START, "think")
  .addEdge("think", "notify")
  .addEdge("notify", END)
  .compile();

const result = await graph.invoke({});
console.log(result.outcome);
