# Honest sentences: what the gate says before anyone looks at it

Design, 2026-09-19. Status: accepted, PG-00 implemented in the same session.

## Where this came from

A design brief (`BES_OSS_PROJESI_MASTER_SPEC_VE_BUYUME_PLANI`, 2026-09-19, PG-GROWTH-1) proposes a
"policy replay lab": a visual two-policy comparison built on the existing `simulate`. Mapping the
brief against the source turned up two things that change the order of the work.

**The first is a shipped defect.** `explain()` rendered a decision nothing would ever retry as
`"Held until 08:00 because ..."`. Measured:

```
allowed  : false
retryAt  : (none)
outcome  : reject
sentence : Held until 08:00 because the user's quiet hours run 22:00 to 08:00 Europe/Istanbul ...
```

`quietHours` can only `pass`, `skip` or `reject` (`src/checks.ts:201-218`); it never defers. So the
instant in that sentence was not a hold ending at 08:00. It was the end of the quiet window, and the
sentence invited the reader to expect a delivery that no code path would ever produce. Three test
expectations pinned it, in two languages, and the localisation carried it too
(`"08:00 kadar bekletildi"`).

**The second is a claim `simulate` was not making.** Replaying one logged stream under a different
policy is an unbiased estimate of that policy only when the policy that wrote the log chose at
random (Li, Chu, Langford and Wang, *Unbiased Offline Evaluation of Contextual-bandit-based News
Article Recommendation Algorithms*, WSDM 2011, arXiv:1003.5956). Against the generated demo week
that condition is irrelevant, and the demo week says what it is. But `--events` invites a reader to
point the tool at their own traffic, which was logged while some policy was already deciding what to
send, and in that case the counts are an illustration rather than an estimate. Before this change a
local stream printed **no footer at all**: the case that most needed the qualifier was the one case
that got nothing.

Both are the same failure: a statement that reads as a measurement and is not one. A visual layer
built over either of them would make the wrong thing easier to believe, which is why the visual work
(PG-02) is sequenced after this and not before it.

## What PG-00 changes

**1. The summary may name an instant only when the decision will be reconsidered at it.**
`src/explain.ts` gated the `until` fact on `entry.outcome === "defer"`. The window is not lost: the
clause already names it, so a quiet-hours reject now reads *"Held because the user's quiet hours run
22:00 to 08:00 Europe/Istanbul and normal priority is below the critical floor needed to override
them."* Deferrals keep their instant, which `test/explain.test.ts` and
`python/tests/test_explain.py:449` both pin.

Applied identically to `python/src/proactive_gate/explain.py`. Go has no `explain` and is unaffected.
**`explain-parity` is not part of `npm test`**: fixing only TypeScript would have left the two
languages disagreeing with a green local suite. It is run here explicitly, and reports 710 sentences
identical across 203 decisions in 58 fixtures.

**2. `simulate` declares where its stream came from.** `SimOptions.stream` and `SimResult.stream`
carry `"synthetic" | "local"`, and absent means no claim was made, which is not the same as
`"synthetic"`. The library cannot know; only the caller that loaded the events does, so the caller
declares it and the result echoes it. Nothing branches on the value. `--json` carries it, because
that is the surface a machine reads. The CLI declares `"local"` whenever `--events` is given.

`LOCAL_STREAM_NOTE` is the footer a local stream now prints. It states the condition rather than only
the caveat, cites the proof, and says what the outcomes are not: nothing here observes what the
recipient did with a message.

**3. The README's count matched no run.** It said the policies disagree about 73 candidates; the tool
prints `80 of 171: 73 on the outcome, 7 on the reason, 0 on when it landed`. The 0.7.0 changelog was
already correct, and so was the docs site. One line, rewritten from the output rather than to
preserve the old number.

The same wrong sentence appeared in `README.md`, `README.tr.md` and
`docs/site/src/content/docs/decisions.md` as an example of the product's output; all three were
corrected. **`CHANGELOG.md` was left alone**: its entry describes what 0.5.0 shipped, and editing a
changelog entry rewrites the record rather than correcting it.

## Non-goals

- No new check, store, adapter or runtime dependency; no change to any decision. `conformance` is
  byte-identical at TypeScript 58/58, Python 58/58, Go 58/58 before and after.
- No change to what `simulate` computes. `stream` is metadata about the input, not an input to the
  algorithm.
- No claim that the demo week resembles anyone's traffic, which `DEMO_WEEK_NOTE` already says.
- No estimate of user impact. Nothing here was tried on a user.

## Testing

- `test/explain.test.ts`: *a decision that will not be retried never names an instant* asserts the
  fixture really is a reject (`retryAt === undefined`) before asserting the sentence, so a future
  change that turns it into a deferral fails loudly instead of passing vacuously.
- `test/simulate.test.ts`: the declaration round-trips, absent stays absent, and declaring it changes
  neither `differenceCounts` nor the disagreement count.
- Non-vacuity was checked by reverting the guard: four tests fail, including the new one.
- Three expectations that encoded the defect were corrected, each with a comment saying it was
  changed because it pinned a defect and not because a test failed.

## What PG-02 will need, recorded here because it is not obvious

`simulate` is not reachable from the browser. `src/index.ts` does not export it and
`docs/site/scripts/bundle.mjs` bundles `src/index.ts` alone, so the shipped playground has no access
to `SimResult`. A thin UI over the existing simulator therefore needs either a widened package entry
or a **second esbuild entry point**. The second is the one to take: the package's published surface
stays where it is, which is what the brief's own PG-T10 exists to protect.

One trap in the same area: `SimResult.timeline` keeps only the final record per candidate, and in the
demo week no candidate has more than one attempt. A view of "every attempt for one candidate" reads
`SimRun.records`, and against the shipped demo it renders empty.

## Not in scope, recorded so the evidence is not lost

Two findings from the literature review that ran alongside this work. Neither is implemented, and
neither enters the backlog without a demand signal.

**Deferral granularity.** Fitz, Kushlev, Jagannathan, Lewis, Paliwal and Ariely, *Batching smartphone
notifications can improve well-being*, Computers in Human Behavior 101 (2019), randomised, n = 237,
four arms. Batching three times a day at fixed clock times improved attention, mood and stress
against the unmanaged default; **hourly batching "did not differ from the control"** on every measure
but one; and receiving nothing at all raised anxiety and fear of missing out without improving
concentration. Read against `deferred(retryAt)`, that is evidence about granularity, and about
`held` forever being a harm rather than a neutral. It is also evidence about *whole-phone* batching,
not about one agent's messages, so the mechanism may transfer and the null result may not.

**Priority names.** RFC 8030 already standardises `very-low | low | normal | high` for push urgency
and makes TTL a required header. Aligning the priority and expiry vocabulary would cost a rename and
buy a shared language with every Web Push sender. Verified against the RFC text, not from memory.
