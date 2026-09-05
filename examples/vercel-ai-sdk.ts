/**
 * A background agent that decides, once an hour, whether it has something worth
 * saying, then asks the gate whether it may say it now. The gate is the only
 * place that knows about consent, quiet hours, the trust ramp and the budget.
 *
 * Run with: npx tsx examples/vercel-ai-sdk.ts   (needs `ai` and a provider key)
 */
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { createGate, defaultChecks, MemoryStore } from "proactive-gate";

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
  const { text } = await generateText({
    model: openai("gpt-4o-mini"),
    prompt: "You are a calendar assistant. In one sentence, is there anything the user should be told right now? Answer NONE if not.",
  });
  if (text.trim() === "NONE") return;

  const candidate = { id: crypto.randomUUID(), type: "insight", priority: "normal" as const, surfaces: ["push", "feed"], payload: text };
  const decision = await gate.evaluate({ user, candidate });
  if (!decision.allowed) return; // the reason is already logged by onDecision
  if (decision.deliverAt) return schedule(decision.deliverAt, candidate);

  // Consume one unit of the daily budget right before sending. If another
  // instance got there first, this returns false and nothing is sent.
  if (await gate.commit(decision, { user, candidate })) await send(decision.surfaces, text);
}

async function send(surfaces: string[], text: string) {
  console.log(`send on ${surfaces[0]}: ${text}`);
}
function schedule(at: Date, candidate: unknown) {
  console.log(`deferred to ${at.toISOString()}`, candidate);
}

await tick();
