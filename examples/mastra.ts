/**
 * A Mastra agent that runs on a schedule, decides whether it has something worth
 * saying, and asks the gate whether it may say it now. The gate holds every rule
 * about consent, quiet hours, the trust ramp and the budget; the agent holds none.
 *
 * Run with: npx tsx examples/mastra.ts   (needs @mastra/core and a provider key)
 */
import { Agent } from "@mastra/core/agent";
import { openai } from "@ai-sdk/openai";
import { createGate, defaultChecks, MemoryStore } from "proactive-gate";

const assistant = new Agent({
  name: "calendar-assistant",
  instructions: "You watch a user's calendar. In one sentence, say the one thing they should be told right now, or answer NONE.",
  model: openai("gpt-4o-mini"),
});

const gate = createGate({
  store: new MemoryStore(), // RedisStore(client) in production
  checks: defaultChecks({ dailyLimit: 3, quietHoursFloor: "high" }),
  onDecision: (d) => console.log(d.allowed ? `allow ${d.candidateId} -> ${d.surfaces.join(",")}` : `reject ${d.candidateId}: ${d.rejectedBy} (${d.reason})`),
});

const user = {
  id: "ayse",
  consent: true,
  proactiveEnabled: true,
  mode: "normal",
  intensity: "normal" as const,
  timezone: "Europe/Istanbul",
  quietHours: { start: "22:00", end: "08:00" },
  createdAt: "2026-06-01T00:00:00Z",
};

async function tick() {
  const result = await assistant.generate("Is there anything the user should be told right now?");
  const text = result.text.trim();
  if (text === "NONE") return;

  const candidate = { id: crypto.randomUUID(), type: "insight", priority: "normal" as const, surfaces: ["push", "feed"], payload: text };
  const decision = await gate.evaluate({ user, candidate });
  if (!decision.allowed) return; // the reason is already logged by onDecision
  if (decision.deliverAt) return schedule(decision.deliverAt, candidate);

  // Consume one unit of the daily budget right before sending; a second
  // instance racing for the same user gets false here and sends nothing.
  if (await gate.commit(decision, { user, candidate })) await send(decision.surfaces, text);
}

async function send(surfaces: string[], text: string) {
  console.log(`send on ${surfaces[0]}: ${text}`);
}
function schedule(at: Date, candidate: unknown) {
  console.log(`deferred to ${at.toISOString()}`, candidate);
}

await tick();
