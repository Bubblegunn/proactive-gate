# Best-rival analysis, round 7 (2026-10-23)

Written and committed before any round-7 code change (`BEST-RIVAL-SPEC.md` steps 1 to 5). Sources: the round-6 held-out c evidence
(`bench/head-to-head/results/round6-heldout-c/`: `SUMMARY.md`, `runs/haiku/<task>/<arm>/<rep>/final.md`, `grades/haiku/`), the round-5 analysis
(`docs/BEST-RIVAL-round6.md`), and the pinned rival texts read again from the `git archive` copies in `/tmp/r6-rivals` (Courier `18c7bcb`, Knock `cc99682`;
read only, never run outside the harness). Held-out c is now seen. Only Haiku was run on it; Sonnet and the public set have no SDK-path results yet.

## 1. Best rival, task by task (held-out c, Haiku, build `671b716`, SDK path)

| task | ours | best other arm (score) | gap | note |
|---|---|---|---|---|
| g1 | 6.00 | knock-inv, courier 5.67 | +0.33 | ahead |
| g2 | 6.00 | courier, courier-inv 5.67 | +0.33 | ahead |
| g3 | 5.00 [6, 3, 6] | baseline 6.00 [6, 6, 6] | -1.00 | **lost** (knock 5.00 and courier-inv 5.00 tie us; knock-inv 4.00, courier 4.00) |
| g4 | 6.00 | all 6.00 | 0 | ceiling together |
| g5 | 6.00 | knock 6.00 | 0 | ceiling together |

Primary rival for g3: the plain baseline (Claude without a skill). It is the arm that is level with or ahead of us most often over rounds 5 and 6 on Haiku
and second on Sonnet (28.33 in round 5). On the cells where we tie below the ceiling (g3 against knock and courier-inv) the same defect is in the rival arms.

## 2. What the arms do on g3

Task g3 (`tasks/prompts/g3`, 6 outcome criteria): a newsletter and receipt system with `unsubscribe`, `resubscribe`, `mayEmail`; the request says "US and EU, stay on the
right side of the rules"; the only recorded events are opt-outs and re-sign-ups. Criteria 1, 2 and 6 need `mayEmail` to allow marketing to an address that never
unsubscribed (the checker compares before and after an unsubscribe).

- **Baseline (3 of 3 runs, 6/6):** writes opt-out state only, allows marketing to an address with no unsubscribe on record, and records the gap in the answer
  (`runs/haiku/g3/baseline/1/final.md`): "EU consent is not covered ... This module has no opt-in record ... `mayEmail` allows marketing to any address without an
  unsubscribe on record. Your caller must send marketing only to addresses that consented, or the spec needs an opt-in export."
- **Ours, run 2 (3/6) and the rival cells that score 3:** `mayEmail` holds marketing for every address with no opt-in record
  (reason: "there is no explicit marketing opt-in on record for this address, and EU rules require one"). A never-subscribed test address is held, so criteria 1, 2 and 6 fail
  (`grades/haiku/g3-ours-2.json`; the same reason text in `g3-knock-3`, `g3-courier-1`, `g3-courier-inv-2`, `g3-knock-inv-1`). Ours run 2 also made `resubscribe` double as
  the opt-in record, which the request does not say. Ours runs 1 and 3 did not (6/6).
- Count: the "no opt-in on record" block appears in 1 of 3 ours cells and in the 3-score cells of knock (1), knock-inv (2), courier (2), courier-inv (1); baseline 0 of 3.

## 3. Which rule produced the passing behaviour, and why ours did not

- Baseline has no rule; it follows the request. The request names two things the code can see: an unsubscribe and a re-sign-up. It gives no way to record a first opt-in, so a
  check for one can only hold every new customer. The baseline recognises this and notes it.
- Our skill: `skills/proactive-gate/SKILL.md:21` (rule 2) ends with "(d) any other promotion and any other unknown case is held". The agent read the EU mention as making
  a newsletter "another promotion", and held it. Rule 3 (never hold everything, `:22`) is checked only on the one message the agent builds itself, which can be an address it has first
  opted in. Rule 11 (`:30`) says "consent (rule 2) ... are not new blocks, and when unsure whether consent is present, hold". That exception exempts consent from the "do not add a block"
  rule, so it points the same way as rule 2(d) here.
- Rival text pushing toward the same block: Courier `README.md:103` ("Marketing notifications ... require recorded opt-in"), Knock
  `rules/notification-system-implementation.md:391-403` ("Obtain explicit consent", "Maintain consent records"). The rival arms with the skill loaded (knock-inv, courier-inv) lose
  at g3 in 2 of 3 and 1 of 3 runs; the plain arms (knock 1 of 3, courier 2 of 3) also lose, so the block is also the model's own EU reflex.

Class of loss (general): **a block for a signal the interface cannot carry.** When the request's functions can only record opt-outs, "no opt-in on record" is true of every
address, so the rule holds the whole class and the function never allows a message (the failure rule 3 exists to prevent). The correct handling is the baseline's: allow
unless an opt-out is recorded, and state the gap in the answer.

Correction of a round-6 note: the round-6 report said run 2 of g3 also returned a plain sentence where the task wanted a snake_case code. `tasks/prompts/g3` asks for "a short
sentence" in `reason`, and ours run 2 gave one, so that part does not apply to g3 and is dropped. Rule 8 is not changed.

## 4. Technique map

| rival technique | do we have it | general or task-specific | licence | decision |
|---|---|---|---|---|
| "Marketing requires recorded opt-in" (Courier `README.md:103`; Knock `notification-system-implementation.md:391-403`) | rule 2(c)/(d) | general | MIT, MIT | reject as a hold for APIs that cannot record an opt-in; keep when the data carries an opt-in field or a record function. It is the source of the g3 block in the rival arms |
| Record the legal gap in the answer instead of blocking (baseline behaviour, g3 `final.md`) | partly: rule 11 for body checks, not for consent | general | n/a (no text) | **adopt** as an addition to rule 2: no way to record an opt-in means no opt-in check, and a "not enforced" line in the answer |
| Skill not loaded, plain answer (courier on g1, round 6) | n/a | n/a | n/a | not copied |

Nothing is copied from either rival, so `THIRD-PARTY-NOTICES.md` does not change.

## 5. Second-best arms

Knock plain (27.00 total) and courier / courier-inv (27.00 each) lose on g3 by the same block, on g2 (4 to 5 of 6: cap reset and DST) and on g5 only in the invoked forms. Fixing the g3 class
does not open a gap to them: the change only removes a hold. Rule 2(c) (a promotion text needs an opt-in when the data carries one) stays, so the g1 class from round 5 is not reopened.

## Decision carried into the round-7 design (frozen in `docs/HEAD-TO-HEAD.md`, section "Round 7")

a. One general sentence in rule 2, and the matching exception in rule 11: when the request's functions record only opt-outs and give no way to record an opt-in, a missing opt-in
   is not a block; allow when no opt-out is recorded, and write "not enforced: opt-in (the interface cannot record one)" in the answer. A function that does record opt-ins, or data that
   carries an opt-in field, keeps rules 2(a) to (d) unchanged.
b. No other change. The skill length stays within the round-6 length (cost rule).
