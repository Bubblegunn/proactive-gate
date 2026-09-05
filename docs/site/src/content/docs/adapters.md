---
title: Adapters
description: Subpath adapters for the Vercel AI SDK, Mastra, LangChain and OpenAI Agents, and a Claude Code PreToolUse hook.
---

The gate sits between "the model produced something" and "the user's phone buzzed". The
adapters put it at the point each framework already reserves for that decision. They are typed
against the shape of a call, not against the framework package, so nothing else has to be
installed.

## Vercel AI SDK

```ts
import { gateToolApproval } from "proactive-gate/ai-sdk";
const approve = gateToolApproval({ gate, toInput: (call) => call.input.gate });
const { approved, reason } = await approve(call); // answer the tool's needsApproval
```

## Mastra

```ts
import { gateProcessor } from "proactive-gate/mastra";
const agent = new Agent({ ..., outputProcessors: [gateProcessor({ gate, toInput })] });
```

## LangChain

```ts
import { gateMiddleware } from "proactive-gate/langchain";
```

## OpenAI Agents

```ts
import { gateGuardrail } from "proactive-gate/openai-agents";
```

Each adapter denies with the gate's reason and, by default, commits the budget on approval.

## Claude Code hook

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "send_message",
        "hooks": [{ "type": "command", "command": "npx proactive-gate hook --policy policy.json --tool send_message" }]
      }
    ]
  }
}
```

The hook reads the PreToolUse event on stdin, evaluates `tool_input.gate = { user, candidate }`
against the policy, and prints a `permissionDecision` for the matching tool. Other tools print
nothing.
