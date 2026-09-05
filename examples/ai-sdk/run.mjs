#!/usr/bin/env node
/**
 * The Vercel AI SDK adapter, run without the AI SDK.
 *
 * In an agent, the send tool has `needsApproval: true`, and the gate answers every
 * approval request:
 *
 *   import { gateToolApproval } from "proactive-gate/ai-sdk";
 *   const approve = gateToolApproval({ gate, toInput: (call) => ({ user, candidate: fromCall(call) }) });
 *   const { approved, reason } = await approve(call);
 *   // addToolApprovalResponse({ id: call.approvalId, approved, reason })
 *
 * This script feeds the approver a day of tool calls from day.jsonl, with the clock taken
 * from each line, so it runs offline and prints the same thing every time. The model never
 * sees the rules; a denied call carries the gate's reason, so the model can plan around it.
 *
 *   node examples/ai-sdk/run.mjs
 */
import { readFileSync } from "node:fs";
import { createGate, MemoryStore } from "proactive-gate";
import { gateToolApproval } from "proactive-gate/ai-sdk";

const here = (name) => new URL(name, import.meta.url);
const policy = JSON.parse(readFileSync(here("policy.json"), "utf8"));
const day = readFileSync(here("day.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));

const gate = createGate({ policy, store: new MemoryStore() });

// The user and the clock come from the request the call belongs to; here, from the line.
const context = new Map(day.map((event) => [event.call.toolCallId, event]));
const approve = gateToolApproval({
  gate,
  toInput: (call) => {
    const { user, now } = context.get(call.toolCallId);
    return {
      user,
      candidate: { id: call.toolCallId, type: call.input.type, priority: call.input.priority, surfaces: ["push"] },
      now: new Date(now),
    };
  },
});

let approved = 0;
for (const { call } of day) {
  const result = await approve(call);
  if (result.approved) approved += 1;
  const verdict = result.approved ? "approved" : "denied  ";
  console.log(`${verdict} ${call.approvalId}  ${call.input.text}${result.reason ? `\n         ${result.reason}` : ""}`);
}
console.log(`\n${day.length} approval requests, ${approved} approved, ${day.length - approved} denied`);
