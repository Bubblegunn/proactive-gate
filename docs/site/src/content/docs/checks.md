---
title: Checks
description: The built-in checks, the order the default runs them in, and how to write your own.
---

| # | check | rejects when |
|---|---|---|
| 1 | `killSwitch(isOn)` | your flag is on |
| 2 | `consent()` | `user.consent` is false |
| 3 | `enabled()` | `user.proactiveEnabled === false` |
| 4 | `mode({ allow })` | `user.mode` is not in the list |
| 5 | `snooze({ defer })` | `user.snoozedUntil` is in the future |
| 6 | `mute()` | `candidate.type` is in `user.mutedTypes` |
| 7 | `intensity()` | priority is below the user's intensity floor |
| 8 | `quietHours({ priorityFloor })` | inside the user's local quiet window |
| 9 | `trustRamp({ days, minPriority })` | user is newer than `days` and priority is below the floor |
| 10 | `dismissalCooldown({ dismissals, withinDays, silenceDays })` | the user dismissed that type `dismissals` times in the window |
| 11 | `adaptiveTiming({ nextGoodMoment, surfacesFor })` | never; it moves `deliverAt` or narrows surfaces |
| 12 | `dailyBudget({ limit, bypassPriority, nearLimit })` | the user's local-day counter is at the limit |

`weeklyBudget` and `monthlyBudget` have the same shape keyed on the local ISO week and the
local month. Budgets are consumed in check order at commit.

## Optional, caller-fed checks

These ship off. They read numbers your own model supplies on the candidate.

**`utilityFloor({ costFalseAlarm, costMissedHelp })`** acts only when
`candidate.pAccept >= tau` with `tau = cFA / (cFA + pNeed * cFN)`; `pNeed` defaults to 1. With
no `pAccept` the check skips. That threshold is the classical Bayes decision boundary:
alerting costs `(1 - p) * cFA`, silence costs `p * cFN`. The alerting application is
[Horvitz, Jacobs and Hovel, "Attention-Sensitive Alerting", UAI
1999](https://arxiv.org/abs/1301.6707), whose system is named Priorities.

**`boundedDeferral({ lambda, interruptCost, staleness, boundSeconds })`** never rejects. When
`candidate.busy` is true it moves `deliverAt` to `now + t*` with
`t* = min(bound, lambda * interruptCost / (2 * staleness))`. Defaults: lambda 1/43 per second,
cost 1, staleness 0.0001, bound 240 s, which gives 116 s.

## Primitives the presets compose

`allowedWindow`, `requiresConsent`, `rateLimit`, `recentInteraction`, `windowBudget` and
`monthlyBudget`. They are exported like every other check and usable from JSON policies.

## Writing your own

```ts
const weekendFloor = {
  id: "weekendFloor",
  run: ({ now, priority }) => {
    const day = now.getUTCDay();
    if ((day === 0 || day === 6) && priority !== "high" && priority !== "critical") {
      return { kind: "reject", reason: "weekend: only high priority" };
    }
    return { kind: "pass" };
  },
};
```

A check is an object with an `id` and a `run` function over the context (user, candidate,
`now`, resolved priority, store, surfaces still on the table). Mark it `nonRejecting: true`
when it may only move timing; the gate then ignores a reject from it and says so in the
trace. Give it a `consume(ctx)` method and it becomes a budget the gate consumes at commit.

## Deduplication

`dedupe` is the check for a transport that delivers at least once. It is off unless you
ask for it, with `defaultChecks({ dedupe: true })` or a `{ "id": "dedupe" }` entry in a
policy.

```ts
await gate.evaluate({
  user,
  candidate: { id: crypto.randomUUID(), type: "shipping", dedupeKey: "order:42:shipped" },
});
```

The key is the caller's, because only the caller knows what makes two attempts the same
event. Without one the check skips rather than guessing.

It claims at commit, not at evaluate, with the atomic increment the budgets use, so two
workers holding the same event both pass the check and exactly one commit succeeds. It
consumes before the budgets, so a suppressed duplicate does not spend one of the user's
messages; the cost is that an event refused by an exhausted budget afterwards has still
claimed its key. The window is fixed from the first claim rather than sliding, and
defaults to 24 hours, the retry horizon Stripe and Nylas both use.

Spec clauses 5.5 to 5.8 hold both implementations to this.
