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

## The same decision, in sentences

`decision.reason` is written for the engineer holding the trace. `explain(decision)` renders
the same decision for the person who decides whether the assistant is too chatty, built from
the same trace with nothing added:

```ts
import { explain } from "proactive-gate";

const e = explain(decision);

e.summary;
// "Held until 08:00 because the user's quiet hours run 22:00 to 08:00 Europe/Istanbul
//  and normal priority is below the high floor needed to override them."

e.checks;
// [ { id: "killSwitch", outcome: "pass",   sentence: "The kill switch was off." },
//   { id: "consent",    outcome: "pass",   sentence: "The user has agreed to proactive messages." },
//   { id: "quietHours", outcome: "reject", sentence: "The user's quiet hours run 22:00 to 08:00 …" } ]
```

An allowed decision explains itself too, because "why did this go out at 22:30" is asked more
often than the reverse: *Allowed at 2026-09-04T09:00:00.000Z because no check stopped it.*

The renderer is a pure function of the decision. It reads no clock and inspects neither the
candidate nor the user, so it cannot describe a decision the gate did not make, and a reason
that matches no template is quoted verbatim and attributed to the check that said it rather
than guessed at. `decision.reason` is untouched: the machine reason and the sentence sit side
by side and neither replaces the other.

```ts
explain(decision, { language: "tr", catalogs: { tr } });
```

`language` defaults to `"en"`; another language is a `Partial<Sentences>` merged over English,
so a partial translation still renders and an unknown language code fails loudly instead of
quietly answering in English. The Python sibling ships the same sentences, and CI compares
both renderings of every fixture decision on each push.

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
