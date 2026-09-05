# Mastra docs: an integrations page for proactive-gate

Not opened. Efe approves before any pull request is made. Everything below was checked
against `mastra-ai/mastra` on 5 September 2026.

## Where it goes

Mastra's integrations directory is generated from one sidebar file and one MDX page per
integration:

- page: `docs/src/content/en/integrations/tools/proactive-gate.mdx`
- sidebar entry: `docs/src/content/en/integrations/sidebars.js`, inside the `Tools` category
  (items are `{ type: 'doc', id: 'tools/<name>', label, customProps: { icon } }`, listed
  alphabetically)
- icon: `docs/static/img/integrations/proactive-gate.svg` (the sibling entries use
  `/img/integrations/<name>.svg`; Perplexity uses a remote simpleicons URL instead)

The categories today are agentic UI, auth, browsers, channels, databases, deploy, file
storage, frameworks, observability, sandboxes, tools and voice. None is "guardrails" or
"processors"; `Tools` is the nearest, and the pull request should say so and offer to move
the page if the maintainers prefer a new category. Rules from `docs/CONTRIBUTING.md`:
required frontmatter `title`, `description`, `packages`; sentence-case headings; code
blocks carry a language and, where useful, a `title`; model ids use the
`__GATEWAY_<PROVIDER>_MODEL_<SIZE>__` placeholders; run `pnpm run lint:remark` before
pushing. Every claim in the page below was run against proactive-gate 0.2.0.

## Pull request

Title: `docs(integrations): proactive-gate, a delivery gate as an output processor`

Body:

> Adds an integrations page for proactive-gate, an MIT library that decides whether a
> proactive agent may reach a user right now (consent, quiet hours, trust ramp, dismissal
> cooldown, daily and weekly budgets, platform and legal presets) and logs which check said
> no. Its Mastra adapter is an output processor; `abort(reason)` carries the gate's reason,
> so the tripwire response tells the model why the message did not go out.
>
> The package is typed against the processor call shape, not against `@mastra/core`, so the
> page installs nothing beyond `proactive-gate`. The example on the page runs offline; it is
> `examples/mastra/run.mjs` in the repository, pinned by a test.
>
> I put it under Tools because that is the nearest existing category. Happy to move it, or
> to trim the page, whichever fits the directory.

## The page

````mdx
---
title: "proactive-gate | Tools"
description: "Gate a Mastra agent's proactive messages with proactive-gate: consent, quiet hours, trust ramp, budgets and legal presets as one output processor, with a reason for every message that did not go out."
packages:
  - "@mastra/core"
---

# proactive-gate

[proactive-gate](https://github.com/Bubblegunn/proactive-gate) decides whether a proactive
agent may reach a user right now. It runs an ordered list of checks (consent, operating mode,
snooze, mute, intensity, quiet hours, a trust ramp for new users, a dismissal cooldown, daily
and weekly budgets) and returns a decision with a trace: which check stopped the message and
why. Budgets are consumed at `commit`, right before the send, so two instances cannot both
send the last message of the day.

In Mastra the gate is an output processor. It runs after the model has produced the message
and before anything reaches the user; a rejection calls `abort()` with the gate's reason.

## Prerequisites

- Node.js `v20` or later
- An existing Mastra project. Follow [Get started](/docs) to create one.

## Installation

```bash npm2yarn
npm install proactive-gate
```

No other package: the adapter is typed against the shape of the processor call.

## Add the processor to an agent

```typescript title="src/mastra/agents/assistant.ts"
import { Agent } from '@mastra/core/agent'
import { createGate, defaultChecks, MemoryStore } from 'proactive-gate'
import { gateProcessor } from 'proactive-gate/mastra'

const gate = createGate({
  store: new MemoryStore(), // RedisStore(client) when more than one instance runs
  checks: defaultChecks({ dailyLimit: 3, quietHoursFloor: 'high' }),
  onDecision: (d) => console.log(d.allowed ? `allow ${d.candidateId}` : `reject ${d.candidateId}: ${d.rejectedBy}`),
})

export const assistant = new Agent({
  id: 'calendar-assistant',
  name: 'Calendar assistant',
  instructions: 'Say the one thing the user should be told right now, or answer NONE.',
  model: '__GATEWAY_OPENAI_MODEL_NANO__',
  outputProcessors: [
    gateProcessor({
      gate,
      // Who is about to be interrupted, and with what. Usually read from the request context.
      toInput: () => ({
        user: { id: 'ayse', consent: true, timezone: 'Europe/Istanbul', quietHours: { start: '22:00', end: '08:00' }, createdAt: '2026-06-01T00:00:00Z' },
        candidate: { id: crypto.randomUUID(), type: 'insight', priority: 'normal', surfaces: ['push'] },
      }),
    }),
  ],
})
```

When the gate rejects, the processor calls `abort('proactive-gate: rejected by quietHours:
quiet hours 22:00 to 08:00 Europe/Istanbul; priority normal is below the floor (high)')`.
The agent's result carries that tripwire reason, memory processors do not run, and the
message is not saved.

## Policy as a file

The same checks can be a JSON document, reviewable in a pull request and shared with the
CLI, the Python package and the browser playground:

```typescript title="src/mastra/gate.ts"
import { readFileSync } from 'node:fs'
import { createGate } from 'proactive-gate'

export const gate = createGate({ policy: JSON.parse(readFileSync('policy.json', 'utf8')) })
```

```json title="policy.json"
{
  "specVersion": "1.0.0",
  "checks": [
    { "id": "consent" },
    { "id": "quietHours", "priorityFloor": "high" },
    { "id": "trustRamp", "days": 7, "minPriority": "high" },
    { "preset": "usTcpa" },
    { "id": "dailyBudget", "limit": 3, "bypassPriority": "critical" }
  ]
}
```

`{ "preset": "usTcpa" }` expands to the 8 a.m. to 9 p.m. local window from 47 CFR 64.1200;
fourteen presets ship with their sources.

## Replay a day before shipping a policy

```bash
npx proactive-gate replay candidates.jsonl --policy policy.json --commit
```

prints how many candidates were allowed and which check stopped the rest. The repository's
`examples/mastra/run.mjs` makes the same `processOutputResult` call Mastra makes over a
day of candidates, offline, so the behaviour above can be seen without a model key.

## Links

- [Repository and README](https://github.com/Bubblegunn/proactive-gate)
- [Docs and playground](https://bubblegunn.github.io/proactive-gate/)
- [The behaviour contract the adapters are held to](https://github.com/Bubblegunn/proactive-gate/tree/main/spec)
````

## Sidebar entry

```js
{
  type: 'doc',
  id: 'tools/proactive-gate',
  label: 'proactive-gate',
  customProps: { icon: '/img/integrations/proactive-gate.svg' },
},
```

placed between `tools/perplexity` and `tools/tavily`.

## Icon

A 28 by 28 monochrome mark, so it reads on both themes with `customCSS: 'dark:invert'` if the
maintainers want it:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" fill="none" stroke="#111" stroke-width="2.2" stroke-linecap="round">
  <path d="M6 5v18M22 5v18"/>
  <path d="M6 14h9"/>
  <path d="M18 11l4 3-4 3"/>
</svg>
```

## Before opening

1. Efe's approval.
2. Fork `mastra-ai/mastra`, add the three files, run `pnpm install && pnpm run lint:remark`
   in `docs/`, build once with `pnpm run dev` and open the page.
3. One commit, conventional title as above, signed if the repository requires it.
4. Record the PR in `Open-Source-Contributions/Evidence/launch-metrics.md` as
   `INTEGRATION_DOCS_PR_OPENED`; it becomes a contribution only when a maintainer merges it.
