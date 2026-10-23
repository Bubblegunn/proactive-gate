# Criterion labels (fairness rule F1)

`labels.json` classifies every criterion of every checker as "outcome" (what the user of the finished code
receives) or "process" (how the agent got there). It was written on 2026-10-21 by a separate Sonnet agent that
was given only `prompts/` and `checkers/` and had not read the library, the skill or the references. The
labels were committed before the runs they apply to. The scorer reports an outcome-only table (criteria
labelled "outcome") next to the full table. All 48 criteria were labelled outcome: each one runs the produced
code and compares what it returns or stores with what the prompt requires.

The auditor also listed criteria that test more than the prompt strictly states (reason wording that must not
contain another rule's words, narrow source host lists, one reading of `brokenAt`). Those were loosened in the
commit "accept every defensible reading in the h1, h2, h6 and x2 checkers" before any run.

## Round 3 (Z1 to Z6)

Labelled on 2026-10-22 by a fresh Sonnet auditor that had read only the prompts, the checkers and the criteria file.
All 36 criteria are "outcome". The auditor listed concerns for 24 criteria; nearly all are the same fact, that the
prompt leaves the requirement to be inferred (hours, the one-per-day rule, thresholds, reason wording). That is how the
tasks were designed (the requirement is cited in `tasks/Z.md` and the prompt does not state it), so those concerns are
recorded here and not treated as defects. Reviewed relaxations were applied before any run (`tasks/Z.md`, Amendments).
