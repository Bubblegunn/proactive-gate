---
title: Integrations
description: Where the gate sits in Mastra, the Vercel AI SDK, LangChain, LangGraph, OpenAI Agents and Claude Code, with two examples that run offline.
---

The gate is one function call between "the model produced something" and "the user's phone
buzzed". Each framework already has a place reserved for that decision; the
[adapters](/proactive-gate/adapters/) put the gate there. This page shows the whole loop per
framework and links the examples in the repository.

Two of the examples need neither the framework nor a network. They import the package by
name, read a JSON policy and a day of candidates with the clock taken from each line, and
print the same thing every run:

```
git clone https://github.com/Bubblegunn/proactive-gate && cd proactive-gate
npm ci && npm run build
node examples/mastra/run.mjs
node examples/ai-sdk/run.mjs
```

## Mastra

An output processor. Mastra calls it after the model has produced the message and before
anything reaches the user; on a rejection the processor calls `abort()` with the gate's
reason, and the tripwire response tells the model why the message did not go out.

```ts
import { Agent } from "@mastra/core/agent";
import { createGate, defaultChecks, MemoryStore } from "proactive-gate";
import { gateProcessor } from "proactive-gate/mastra";

const gate = createGate({ store: new MemoryStore(), checks: defaultChecks({ dailyLimit: 3, quietHoursFloor: "high" }) });

export const assistant = new Agent({
  id: "calendar-assistant",
  instructions: "Say the one thing the user should be told right now, or answer NONE.",
  model: "openai/gpt-4o-mini",
  outputProcessors: [gateProcessor({ gate, toInput: () => ({ user, candidate }) })],
});
```

Offline: [`examples/mastra/`](https://github.com/Bubblegunn/proactive-gate/tree/main/examples/mastra)
runs ten candidates for two users through a policy with weekly and daily budgets; five go
out, and the output names the check that stopped each of the other five. With a model:
[`examples/mastra.ts`](https://github.com/Bubblegunn/proactive-gate/blob/main/examples/mastra.ts).

## Vercel AI SDK

The send tool has `needsApproval: true`, and the gate answers every approval request. A
denied call carries the reason, so the model can plan around it; an approved call has already
consumed the budget.

```ts
import { gateToolApproval } from "proactive-gate/ai-sdk";

const approve = gateToolApproval({ gate, toInput: (call) => ({ user, candidate: fromCall(call) }) });
const { approved, reason } = await approve(call);
// addToolApprovalResponse({ id: call.approvalId, approved, reason })
```

Offline: [`examples/ai-sdk/`](https://github.com/Bubblegunn/proactive-gate/tree/main/examples/ai-sdk)
answers nine approval requests under a policy that includes the TCPA preset; one of them is a
critical alert at 23:00 that the legal window still refuses, because presets carry no
priority bypass. With a model:
[`examples/vercel-ai-sdk.ts`](https://github.com/Bubblegunn/proactive-gate/blob/main/examples/vercel-ai-sdk.ts).

## LangChain and LangGraph

Middleware around the send tool (`proactive-gate/langchain`): a watched tool call is refused
with the gate's reason as the tool result; other tools pass through. In a graph, the notify
node asks the gate before it fires the tool:
[`examples/langgraph.ts`](https://github.com/Bubblegunn/proactive-gate/blob/main/examples/langgraph.ts).

## OpenAI Agents

A tool-input guardrail (`proactive-gate/openai-agents`): the tripwire fires on a rejection
and `outputInfo` carries the decision, including the surfaces an allowed message may use.

## Claude Code

A `PreToolUse` hook. `npx proactive-gate hook --policy policy.json --tool send_message`
reads the event on stdin and prints a `permissionDecision` for the matching tool; other
tools print nothing.
[`examples/claude-code-hook.json`](https://github.com/Bubblegunn/proactive-gate/blob/main/examples/claude-code-hook.json).

## Python

The same policy file runs in the Python package (`Gate.from_policy`), sync or async, and
passes the same fixtures. See [Python](/proactive-gate/python/).

## Listing the gate where these frameworks live

The texts for a Mastra integrations page and a Vercel AI SDK docs pointer are in
[`docs/integrations/`](https://github.com/Bubblegunn/proactive-gate/tree/main/docs/integrations)
in the repository. If you maintain a framework and want the gate in its docs, open an issue
and the page is yours to review.
