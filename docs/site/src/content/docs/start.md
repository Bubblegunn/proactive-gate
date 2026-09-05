---
title: Start
description: Install proactive-gate and make the first decision.
---

A proactive assistant has two halves. The generating half decides what is worth saying. The
suppressing half decides whether to say it now, later, or never. This package is the second
half.

```
npm install proactive-gate
```

Zero dependencies, TypeScript, Node 20 or newer. For Python see [Python](/proactive-gate/python/).

```ts
import { createGate, defaultChecks, RedisStore } from "proactive-gate";

const gate = createGate({
  store: new RedisStore(redis), // MemoryStore() for one instance
  checks: defaultChecks({ dailyLimit: 3, quietHoursFloor: "high" }),
  onDecision: (d) => log.info("gate", d),
});

const decision = await gate.evaluate({ user, candidate });
if (decision.allowed && (await gate.commit(decision, { user, candidate }))) {
  await send(decision.surfaces, candidate.payload);
}
```

`evaluate` runs the checks in order and stops at the first reject. `commit` is the atomic
increment right before you send; it returns false when a concurrent delivery took the last
unit, and it is idempotent on `decision.id`.

## The input

```ts
const user = {
  id: "ayse",
  consent: true,
  timezone: "Europe/Istanbul",
  quietHours: { start: "22:00", end: "08:00" },
  createdAt: "2026-01-01T00:00:00Z",
};
const candidate = { id: "a1", type: "reminder", priority: "normal", surfaces: ["push", "feed"] };
```

A user needs `id` and `consent`; everything else is optional and each check says what it
reads. A candidate needs `id` and `type`; `priority` defaults to `normal`. The gate never reads
`payload`.

## Replay a day before you ship a policy

```
npx proactive-gate replay examples/day.jsonl --policy examples/policy.json --commit
```

The CLI takes a JSONL file of `{ user, candidate, now }` lines and prints the allow rate and
the top rejection reasons. `--json` prints one decision per line for a notebook.
