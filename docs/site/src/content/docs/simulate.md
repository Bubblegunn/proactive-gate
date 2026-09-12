---
title: Simulate
description: Replay one week under two policies and see what each one delivered, held, deferred and spent.
---

One command, nothing to install and nothing to configure:

```sh
npx proactive-gate simulate
```

It replays a week of an assistant that fires when its own data arrives rather than when the
recipient is awake, first with no gate and then through the default order, and prints what each
policy did with every candidate.

|                                                      | no gate | proactive-gate |
| ---------------------------------------------------- | ------: | -------------: |
| delivered                                            |     171 |             74 |
| held                                                 |       0 |             97 |
| delivered inside the recipient's own quiet hours     |      52 |              3 |
| of those, critical, which the floor lets through     |       5 |              3 |
| most one person received in one local day            |       6 |              5 |

The quiet-hours row counts deliveries inside the window each person set for themselves rather than
inside a curfew chosen for them, which is why the user in the week who asked for no quiet hours is
not "protected" from her own preference.

## What the run is, and what it cannot tell you

The week is a generator plus a seed, not anybody's traffic: eight users in five time zones,
candidate instants drawn uniformly across the UTC day, and every parameter written down in
`src/demo-week.ts`. `--dump-events week.jsonl` writes out exactly what it produced.

It measures what a policy does to a stream, which is the only thing a policy decides. It cannot
tell you how often a real assistant has something to say, whether a message was wanted, or what a
recipient did with it. In the generated week every user has consented and no dismissals are seeded,
so `consent`, `enabled`, `killSwitch`, `dedupe` and `dismissalCooldown` never fire.

## Your own traffic

```sh
npx proactive-gate simulate your-candidates.jsonl
```

One JSON object per line, the same shape `replay` reads:

```json
{ "user": { "id": "u1", "consent": true, "timezone": "Europe/Istanbul" },
  "candidate": { "id": "c1", "type": "reminder", "priority": "normal" },
  "now": "2026-09-08T21:40:00Z" }
```

Nothing leaves your machine: the simulator is the same package, running locally, with an in-memory
store per policy.

## Two policies against each other

```sh
npx proactive-gate simulate --policy examples/policies/aggressive.json \
                            --policy examples/policies/respectful.json
```

This is the comparison to run before changing a policy in production. Both sides are real policy
documents, so neither is a rival built to lose, and the output lists the candidates they disagree
about one at a time.

## Flags

| flag                           | what it does                                                        |
| ------------------------------ | ------------------------------------------------------------------- |
| `--policy <file>`              | a policy document to run. Once compares it against no gate; twice compares the two |
| `--seed <n>`                   | seeds the generated week and the simulated transport (default 7)    |
| `--limit <n>`                  | timeline rows to print, `0` for all (default 20)                    |
| `--disagreements`              | only the candidates the policies disagreed about                    |
| `--why`                        | each held candidate's sentence, from `explain()`, under its row     |
| `--transport-failure-rate <f>` | fraction of simulated sends that fail (default 0)                   |
| `--dump-events <file>`         | write the generated week to a file as JSONL and exit                |
| `--json`                       | the whole result, for computing your own figures                    |

## Three numbers it refuses to collapse

- **allowed is not sent.** `evaluate` says a message may go, `commit` takes the budget unit and can
  still refuse when a concurrent delivery took the last one, and only then does a transport run.
  `lost at commit` and `spent, not delivered` are counted apart from `delivered`.
- **deferred is not rejected.** A deferral carries a `retryAt`, and the candidate is re-evaluated
  from scratch at that instant, so consent, the clock and the budget are read again. A deferral
  nobody could still act on is reported as expired rather than dropped quietly.
- **no gate is not a policy.** The baseline bypasses the gate entirely. A policy with no checks is
  not expressible, and a rival built to lose would measure nothing.

## Can adding a check make the gate louder? Yes, and here is the case

The obvious property, that a longer policy can only deliver less, is **false**, and the simulator is
what found the case. With a daily budget of one: the first message is delivered at 10:00, the second
arrives at 23:50 carrying a snooze that runs to 00:10 the next day.

- `consent + dailyBudget(1)` refuses the second one. The day's single unit is gone. **One delivery.**
- `consent + snooze({ defer: true }) + dailyBudget(1)` holds it for twenty minutes and re-evaluates
  it at 00:10, by which time the local day has rolled over and its budget is untouched. **Two.**

Adding a check raised the number of deliveries. That is not a defect in the gate: a deferral is
meant to move work into a later window, and the daily budget is per local day by specification. It
is the general claim that was too broad, and it was published in 0.6.0 before this case was found.

**What is true, and the scope it holds in.** Over the default order, whose checks all reject rather
than defer, no added check raised deliveries in **180 policy pairs** across three generated weeks:
ten written-out subsets of the twelve checks, each pair differing by exactly one check. That is a
measured result over those weeks, not a theorem, and it says nothing about a policy that includes a
deferring check, which the case above covers. `test/monotonicity.test.ts` holds both halves: the
counterexample first, so nobody can read the claim without meeting the case that limits it.

## What the simulator guarantees about its own measurements

A simulation is easy to make convincing and hard to make true. These are the contracts it holds,
each one covered by `test/simulate-fidelity.test.ts`, and each one wrong in 0.6.0 before a review
found it:

- **One clock.** The store is built with the simulation's clock, so a TTL expires when the simulated
  week passes it. On a real-time clock a week of simulated traffic takes milliseconds, so a
  one-hour deduplication window never reopens and the run quietly reports a duplicate that a real
  deployment would have allowed.
- **State is read again, never remembered.** A deferred or postponed candidate is re-evaluated
  against the newest state of that user at or before the moment it runs. Consent withdrawn between
  a deferral and its retry stops the send. A stream can carry a state change with no candidate
  attached, which is how a revocation is expressed.
- **Evaluation time and delivery time are different instants.** When a check moves a send to a
  later moment, quiet hours and daily volume are counted at the delivery, because that is when the
  person is disturbed, and the send is re-evaluated then. That second look asks only the checks
  that read state: a budget already took its unit at evaluation, so asking it again would refuse
  the delivery on the strength of the candidate's own spend, which is a hold the library would
  never produce. The unit itself stays on the day the gate spent it, because that is the day its
  key names, which is also what the store says if you read it.
- **Deferral terminates.** A `retryAt` that is missing, in the past, or equal to now is recorded as
  a broken deferral rather than re-queued; the expiry window is measured from the candidate's first
  sighting rather than its latest hop; and an attempt cap sits behind both. Each of those three
  inputs used to run until the process ran out of memory.
- **A candidate id is an identity.** Two candidates sharing one are refused with an error, because
  ids are how a candidate is followed across policies and attempts.
- **A difference is more than a different outcome.** Two policies that hold the same candidate for
  different reasons, or deliver it at different times, are reported as differences of their own
  kind. In the aggressive-against-respectful comparison that is 7 candidates that 0.6.0 counted as
  agreement.
