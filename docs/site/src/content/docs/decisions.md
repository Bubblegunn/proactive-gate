---
title: Decisions
description: What a decision carries, and the outcome model behind it.
---

Every evaluation returns a `Decision`:

```ts
{
  id: "ayse:a1:2026-09-04T03:00:00.000Z#1",
  allowed: false,
  userId: "ayse",
  candidateId: "a1",
  rejectedBy: "quietHours",
  reason: "quiet hours 22:00 to 08:00 Europe/Istanbul; priority normal is below the floor (high)",
  surfaces: [],
  shadowed: [],
  nearLimit: [],
  trace: [
    { id: "killSwitch", outcome: "pass", ms: 0.02 },
    { id: "consent",    outcome: "pass", ms: 0.01 },
    { id: "quietHours", outcome: "reject", reason: "quiet hours 22:00 to 08:00 …", ms: 0.09 }
  ],
  evaluatedAt: 2026-09-04T03:00:00.000Z
}
```

## Outcomes

A check returns one of five outcomes.

| outcome | stops? | carries |
|---|---|---|
| `pass` | no | optional `reason`, optional `nearLimit { used, limit }` |
| `reject` | yes | `reason` |
| `defer` | yes | `reason`, `retryAt` |
| `adjust` | no | `reason`, optional `deliverAt`, optional `surfaces` |
| `skip` | no | `reason` |

`defer` produces a decision with `allowed: false`, `deferredBy` and `retryAt`, and no
`rejectedBy`. Snooze with `{ defer: true }` is the built-in example: the decision says when to
try again instead of saying no.

## Shadow mode

A check with `shadow: true` runs and is traced with its real outcome, but a reject or defer
from it does not stop evaluation. Its id lands in `decision.shadowed`. Ship a new check in
shadow for a week, count how often it would have fired, then turn it on.

## Near-limit notes

Budgets report `nearLimit: { used, limit }` on the pass that reaches the threshold (80 percent
by default). The decision lists every such note under `nearLimit`, so a dashboard can show who
is about to go quiet.

## Hooks

```ts
createGate({
  checks,
  hooks: {
    before: (ctx, check) => {},
    after: (ctx, check, outcome, ms) => {},
    error: (ctx, check, error) => {},
    finally: (decision) => {},
  },
});
```

Hooks observe. A hook that throws is routed to `error` and never changes the decision.
`examples/otel.ts` in the repository turns them into one span per check.

## Failing open

When a store-backed check throws, the default records `skip` with the error and continues. A
cache outage should not silence every user of a product whose whole point is to speak up.
`onStoreError: "closed"` turns the same failure into a rejection that names the check.
