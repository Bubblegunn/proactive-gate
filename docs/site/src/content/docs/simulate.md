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

## Adding a check cannot make the gate louder

`test/monotonicity.test.ts` runs the claim rather than asserting it: over three generated weeks and
ten subsets of the default order it compares **180 policy pairs**, each pair differing by one
check, and no added check raised the number of deliveries. It also checks the two cases a budget
makes suspicious, where holding a night message leaves a unit unspent for the morning and a
deferring snooze can carry a candidate into the next local day.

That is a measured result over those weeks, not a theorem. If a counterexample ever appears the
test fails, and the mechanism gets written down instead of the test being loosened.
