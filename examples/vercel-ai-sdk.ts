/**
 * Vercel AI SDK: the send tool needs approval, and the gate answers every
 * approval request. The model never learns the rules; it only sees "denied:
 * rejected by quietHours (...)" and can plan around it.
 *
 * Run with: npx tsx examples/vercel-ai-sdk.ts   (needs `ai`, a provider key)
 */
import { generateText, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { createGate, defaultChecks, MemoryStore } from "proactive-gate";
import { gateToolApproval } from "proactive-gate/ai-sdk";

const gate = createGate({ store: new MemoryStore(), checks: defaultChecks({ dailyLimit: 3, quietHoursFloor: "high" }) });

const user = { id: "ayse", consent: true, timezone: "Europe/Istanbul", quietHours: { start: "22:00", end: "08:00" }, createdAt: "2026-06-01T00:00:00Z" };

const sendMessage = tool({
  description: "Send a proactive message to the user",
  inputSchema: z.object({ type: z.string(), priority: z.enum(["low", "normal", "high", "critical"]).default("normal"), text: z.string() }),
  needsApproval: true,
  execute: async ({ text }) => ({ sent: true, text }),
});

// The approval step: the gate decides, and commit consumes the budget when it says yes.
const approve = gateToolApproval({
  gate,
  toInput: (call: { toolCallId?: string; input?: { type?: string; priority?: "low" | "normal" | "high" | "critical" } }) => ({
    user,
    candidate: { id: call.toolCallId ?? "call", type: call.input?.type ?? "reminder", ...(call.input?.priority ? { priority: call.input.priority } : {}), surfaces: ["push"] },
  }),
});

const result = await generateText({
  model: openai("gpt-5"),
  tools: { sendMessage },
  prompt: "Remind Ayse about tomorrow's appointment if that is worth an interruption right now.",
});

for (const call of result.toolCalls) {
  const { approved, reason } = await approve(call);
  console.log(approved ? `approved ${call.toolCallId}` : `denied ${call.toolCallId}: ${reason}`);
  // Continue the loop with the approval response; see the AI SDK tool-approval docs.
}
