# Show, don't add: the policy simulator and the scope freeze

Design, 2026-09-12. Status: accepted, implementing in the same session.

## The problem, stated the way an outsider would state it

This repository is a week old and has twelve checks in a fixed order, fifteen platform and legal
presets, four framework adapters, five stores across two languages, a JSON policy compiler, a
conformance suite with its own tag series, an `explain()` renderer, a browser playground and a
Claude Code hook. Every one of those was justified when it was written. Seen from outside, together,
they invite a different question:

> Did this grow because something needed it, or was every possible feature added?

The honest answer matters more than the feature count, because the thing the project cannot
currently answer is smaller and harder:

> Why would a stranger type `npm install proactive-gate` on Monday morning?

Nothing in the repository answers that with a number. The README explains the checks, the spec
states the behaviour, the benchmark argues against hand-written `if` statements. A reader still has
to take on trust that a gate changes anything they would care about.

A sixteenth preset does not move that. Neither does a fifth store, a fifth adapter, or Japan after
India. Those grow the surface an outsider must judge without growing the evidence they judge it on.

## What this design does

Two halves, and they are deliberately in one change so the addition is paid for by the subtraction.

**The subtractive half.** Say what the library will not do, freeze the preset catalogue behind a
stated bar, prune the roadmap of the invitations that produced the accumulation, close the issues
that exist only to invite more of it, and point the contributor energy that has arrived at the two
things that would change the project's standing: an independent implementation of the specification,
and a real adopter.

**The additive half, and it is one command.** `proactive-gate simulate` replays one stream of
candidates under two policies and shows, per candidate, what each policy did with it: sent, held and
why, deferred and until when, which budget it spent. With no arguments it runs a generated week
against the default order and against no gate at all, so a stranger sees the difference in ten
seconds without installing anything (`npx proactive-gate simulate`). Pointed at a JSONL file of
their own candidates, it answers the same question about their traffic, which is the only honest
on-ramp to adoption this project can build for itself.

The simulator adds no check, no store, no adapter, no dependency, and does not touch the decision
path. It runs the gate that already exists twice and renders the difference. That is the distinction
the scope statement will draw in public: **evidence tooling grows, engine surface is frozen.**

## Non-goals

- No new check, preset, adapter, store, or runtime dependency.
- No change to `Decision`, to the check order, or to any fixture. The conformance table must come
  out of this work byte-identical.
- No claim that the generated week resembles anyone's real traffic. It is a documented generator's
  output; every surface that shows its numbers says so.
- No attempt to manufacture an adopter. The design lowers the cost of becoming one and stops there.

## Architecture

Four pieces, each usable without the others.

**1. `src/simulate.ts` — the core.** One function, no I/O:

```ts
simulate(options: {
  events: EvaluateInput[];
  policies: SimPolicy[];      // { label, policy? } — policy omitted means the no-gate baseline
  seed?: number;              // transport, and nothing else
  transportFailureRate?: number;
}): Promise<SimResult>
```

`SimResult` carries one `SimRun` per policy (`records: SimRecord[]`, plus counts) and a `timeline`
that joins the runs on candidate id. A `SimRecord` is the decision plus what happened after it:
`{ input, decision?, outcome, deliveredAt?, spentBudget? }` where `outcome` is one of `sent`,
`held`, `deferred`, `spentNotDelivered` (the budget unit was taken and the simulated transport still
failed — three different numbers that must not be collapsed).

The baseline is not a degenerate policy. A policy with no checks is not expressible (`spec-lint`
requires a non-empty list) and a rival built to lose measures nothing, which `bench/compare.mjs`
already says about `bench/naive.mjs`. So the baseline bypasses the gate entirely: every candidate is
sent, subject only to the simulated transport. That is not a strawman, it is the behaviour of the
product this library is installed into.

Deferral is a real state, not a rejection: when a check defers, the record keeps `retryAt`, and the
candidate is re-evaluated at that instant against the same store, the way `bench/compare-policies.mjs` already
does. There must be one comparator in the project rather than two.

**Deviation, recorded during implementation.** The plan was to promote that script's core and leave
the script as a thin caller. Its test asserts the script's internals by inspecting its source (that
it imports no rival, that it reads no wall clock, that its policy A is built from known check ids),
so a caller-shaped rewrite would have kept the file alive only to satisfy tests about its shape.
What happened instead: the typed core is written for the multi-policy timeline, the script and its
test are deleted, and the assertions worth keeping (no wall clock, store isolation per run, the
three-number arithmetic, determinism) are ported into `test/simulate.test.ts`. Its two policies
survive as `examples/policies/aggressive.json` and `examples/policies/respectful.json`, which the
command reads, so the comparison it made is still one command away and is no longer a bench script
only the maintainer runs.

**2. `src/demo-week.ts` — the stream a stranger sees first.** `demoWeek(seed)` returns
`EvaluateInput[]`: eight users in five time zones over seven days, with candidate types and
priorities drawn from a seeded PRNG whose parameters are written down beside it, plus a handful of
recorded dismissals so the cooldown has something to read. The week is defined by the generator and
the seed rather than by a committed blob, so it is auditable and adds nothing to the tarball.
`--dump-events <file>` writes it as JSONL for a reader who wants to see it; `examples/week.jsonl` is
that dump, committed for reading and deliberately not packed.

**3. The CLI command.**

```
proactive-gate simulate [events.jsonl] [--policy <file>]... [--seed N] [--json]
                        [--dump-events <file>] [--limit N]
```

Defaults: the demo week, and two policies, `no gate` and the default order. One `--policy` compares
it against the baseline; two compare against each other. Output is a table: the timeline first
(when, in the user's local time, who, type, priority, then one column per policy with the verdict
and, for anything not sent, the sentence `explain()` already produces), then a summary block
(delivered, held, deferred, delivered between 22:00 and 08:00 local, busiest user-day), then the
stopped-by-check counts, then a footer naming what the run measured and what it cannot show.
`--json` prints the whole `SimResult` for anyone who would rather compute their own figures.

**4. What the numbers are then used for.** The README gains a second screen, "Why you would install
this on Monday", holding the figures from a real run of the default command and the command that
reproduces them. `docs/site` gains a page. Both carry the scope-and-method sentence that `/stats` on
the portfolio already requires of itself: what it covers, how it was measured, and what that method
cannot show.

## The property worth having (issue #22)

Open issue #22 asks for proof that adding a check can never increase deliveries. The simulator makes
it cheap to attempt: generate seeded streams, take a random subset chain of the default order, and
assert `deliveries(S ∪ {c}) ≤ deliveries(S)` for every step. Budgets make this less obvious than it
sounds, because a stricter policy can leave budget unspent that a looser one has already consumed,
and a deferral can move a delivery across a budget boundary.

This is run as an experiment, not asserted as a slogan. If it holds over N seeded streams, the test
states N and the README says exactly that much. If a counterexample appears, the counterexample is
the finding: it goes in the test as a documented case with the mechanism written out, and no claim of
monotonicity is published. Either outcome is publishable; only a claim without the run is not.

## Testing

- `test/simulate.test.ts`: determinism (two runs of the same seed are identical), the baseline sends
  everything, the default order sends nothing between 22:00 and 08:00 local in the demo week, no user
  receives more than the daily cap, a deferred candidate carries `retryAt` and is re-evaluated at it,
  `spentNotDelivered` is counted apart from `sent`, and the JSON shape is stable.
- `test/monotonicity.test.ts`: the property above.
- The assertions ported out of `test/compare-policies.test.mjs` before it was deleted: no wall-clock
  read anywhere in the simulator, one store per run so no policy can move another's counters, and
  the partition of final outcomes, which is what keeps a spent budget from being called a delivery.
- The gates that must come out unchanged: `spec-lint`, the conformance table at its current count in
  both languages, `explain-parity`, and `release-gate` with the new files listed in the pack
  allowlist.

## The scope statement

`README.md` and `ROADMAP.md` gain the same short rule, and it is meant to be quotable:

- The twelve checks are the policy surface. A thirteenth needs a deployment that cannot express its
  rule with the twelve, not a rule that exists somewhere in the world.
- The preset catalogue is **frozen at what is merged**. A new preset needs someone who is shipping to
  that channel or under that instrument and will say so on the issue. "This country also has a law"
  is not the bar, because every country does, and a preset nobody ships against rots unread.
- Adapters and stores are frozen on the same terms: the next one arrives with the person who needs it.
- What grows instead: evidence. The simulator, the conformance suite, and an independent
  implementation of the specification.
- What will never be added: anything that needs a server, a hosted account, or reads message content.

`ROADMAP.md` loses "Apple push quiet-time guidance" and the open invitation to more presets. Issues
that exist only to invite accumulation are closed with that rule quoted, so the closure reads as a
decision rather than as neglect.

## The two moves this design cannot make alone

**An independent implementation.** The sentence worth earning is "the TypeScript, Python and
independently implemented Go versions all conform to the same behavioural specification", and it is
only true if someone who is not us writes the third one. So the design does not write it. It makes it
as cheap as possible to write: `spec/CONFORMANCE.md` gains a section on implementing the
specification in another language, naming the fixture loader shape, the passing rule, the skip
declaration, and what a conforming implementation may leave out; issue #16 is rewritten as the
recruiting issue that points at it, and the contributor who has already sent four pull requests this
week is invited to it by name. A third-party implementation is listed in the README only when its
author says it conforms and the fixtures agree.

**A real adopter.** Nothing in a repository can manufacture one. What the simulator does is remove
the reason to say no: a team can measure the gate against their own notification log before they
install it. Outreach is Efe's, and the honest place to record any adoption is the evidence pack, with
a date and a screenshot, not the README.

## Sequence

1. Promote the comparator core into `src/simulate.ts`; bench script becomes a caller. Tests stay green.
2. `src/demo-week.ts`, `examples/week.jsonl` dump, pack allowlist updated.
3. The `simulate` command, its table, its JSON, its footer.
4. `test/simulate.test.ts`, then the monotonicity experiment.
5. README second screen and scope section, `ROADMAP.md`, docs page, `spec/CONFORMANCE.md` section.
6. Issue sweep: close what is finished or invitation-only, rewrite #16, invite the contributor.
7. Release `0.6.0`, because the README's own first command is `npx proactive-gate simulate` and it
   must work for a stranger, then verify it from the registry.
