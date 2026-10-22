# Best-rival analysis, round 6 (2026-10-23)

Written and committed before any round-6 code change, following `BEST-RIVAL-SPEC.md` steps 1 to 5. Sources: the published
round-5 held-out tables (`bench/head-to-head/results/round5-heldout/SUMMARY.md`), the per-cell final answers and code
(`.../runs/<model>/<task>/<arm>/<rep>/`), the checker output (`.../grades/`), and the pinned rival texts read from `git archive`
copies in `/tmp/r6-rivals` (Courier `18c7bcb`, Knock `cc99682`; read only, never run outside the harness). The public set Z1 to Z6 has no
SDK-path rival results yet (the earlier public rounds ran on the CLI path), so this analysis uses the round-5 held-out set only.

## 1. Best rival, task by task (round 5, build `5dbfaf3`, SDK path)

| model | task | ours | best other arm (score) | gap | note |
|---|---|---|---|---|---|
| Haiku | g1 | 4.00 | all five others 3.00 | +1.00 | ours won on one lucky run (3, 3, 6) |
| Haiku | g2 | 6.00 | knock-inv, courier-inv 6.00 | 0 | ceiling together |
| Haiku | g3, g4, g5 | 6.00 | all 6.00 | 0 | saturated |
| Sonnet | g1 | 3.00 | baseline, courier 5.00 | -2.00 | **lost** |
| Sonnet | g2 | 6.00 | knock, knock-inv, courier, courier-inv 6.00 | 0 | ceiling together |
| Sonnet | g3, g4, g5 | 6.00 | all 6.00 | 0 | saturated |

Primary rival: Sonnet, courier (total 29.00; courier-inv 28.00); Haiku, knock-inv and courier-inv (27.00 each). Second most often
level or ahead: baseline on Sonnet (28.33), knock on Sonnet (28.00).

## 2. The primary rival, read end to end

Courier `skills/courier/SKILL.md` (19,026 bytes, 25 reference files). What it tells the agent (`SKILL.md:12-17`): 1 route to the one or two
files for the task, 2 ask when the request is ambiguous, 3 verify shapes against a live source, 4 apply the Universal Rules as constraints.
It is an API-product skill: `message.to` forms, `send`, journeys, preferences, provider setup. Rules that touch our tasks:
1. SMS is handled by the provider, not by Courier; mirror a provider STOP into a preference (`references/channels/sms.md:10`, `:283-310`).
2. Hold non-urgent SMS outside a window with a delivery window (`sms.md:378-381`).
3. SMS copy shape `[Brand]: [Message]. [CTA]. [Opt-out]` and `Reply STOP to unsubscribe` as a component of the message text (`sms.md:120-135`). This is
   writing guidance for a message, not a rule for a send gate.
4. A topic default holds until the user changes it (`references/guides/preferences.md:9`, `:68-69`).
On input it does not recognise (a request for a function that returns allowed/reason, no Courier API in scope) the skill does not fire:
`skillCalls` is 0 in all 15 Sonnet courier cells and the answers are those of plain Claude. Invoked form (`courier-inv`): the skill text is read
and its SMS copy template is available; on Haiku g1 this did not help (3.00 in 3 of 3).

Knock `knock-notification-best-practices` (`SKILL.md`, 6 rule files). Relevant statements: "Always provide opt-out instructions for marketing
messages" (`rules/channel-specific-notifications-guidelines.md:123`, a copy guideline for the SMS body); under TCPA "Provide opt-out instructions"
(`rules/notification-system-implementation.md:391-395`, a checklist); "Respect user preferences and quiet hours" (`:30`).

## 3. Cells we lose or tie, side by side

Criteria (from `tasks/TASKS.md`, g1): 1 marketing text at night refused with a reason; 2 allowed 08:00 to before 21:00 local; 3 uses the recipient's zone;
4 follows daylight saving; 5 no consent or STOP refuses marketing with a code different from quiet hours; 6 transactional allowed at night.

**Sonnet g1.** Ours (3 of 3 runs, 3.00): the function returns `missing_opt_out_notice` unless the body contains the word STOP; the answer says "I
require it on every marketing text" and also admits "CTIA recommends opt-out wording, not on every message" (`runs/sonnet/g1/ours/1/final.md`).
Criteria 2, 3, 4 fail, all with `{"allowed":false,"reason":"missing_opt_out_notice"}` on a valid daytime text. Courier (runs 2 and 3, 6 of 6): no body check; the
answer says "The function doesn't read the body. Nothing checks that ... marketing texts ... say 'Reply STOP'. If you want that enforced, it needs a new
rule" (`runs/sonnet/g1/courier/2/final.md`). Courier run 1 (3 of 6) and baseline run 1 (3 of 6) added `missing_opt_out_instructions` and fail the same three.
So the same defect occurs in the rival arms (12 of 18 Sonnet g1 cells over all six arms; 17 of 18 on Haiku). Courier's passing runs did not follow a rule: its SMS
text puts the opt-out in message copy (`sms.md:124-135`), and the request cited the CTIA principles, so each agent decided on its own whether to enforce it.
No courier or knock line says "do not block a text for something the request does not state". Our skill had no such line either, and its rule 7 ("opt-out ...
beats every other rule") pushes toward more blocking.
Why our product did not: `skills/proactive-gate/SKILL.md` has ten rules about what to hold and none about when not to hold. The failure is an extra block, which
the checklist's "Never hold everything" (rule 3) only checks for the one example message the agent builds itself (its own sample text contained STOP).

**Haiku g1.** Ours [3, 3, 6]; the five others [3, 3, 3] each. The 3-score runs (including all rival runs) fail criteria 2 and 3 with the same
`missing_opt_out_*` block. Ours won on a single run without the block. **Haiku g2** (ceiling together): ours [6, 6, 6]; baseline, knock, courier fail
criteria 2 and 3 (cap reset at local midnight, DST) in 2 of 3, 1 of 3 and 3 of 3 runs; both invoked rivals 6.00. No rule gap against the invoked rivals.
**g3 to g5**: saturated, all arms 6.00 on both models (ties at the ceiling).

## 4. Technique map

| rival technique | do we have it | general or task-specific | licence | decision |
|---|---|---|---|---|
| Message-copy template with brand, CTA, "Reply STOP" (Courier `sms.md:120-135`, Knock `channel-specific...:123`) | no (not a gate rule) | general, but it is copy advice | MIT, MIT | reject as a gate check; it is the source of the unrequested block. Adopt the opposite reading: a copy recommendation is a note, not a block |
| Hold non-urgent SMS in a delivery window (Courier `sms.md:378`) | yes, `SKILL.md` rule 6 and `references/guide.md` | general | MIT | already covered |
| Mirror provider STOP into a preference (Courier `sms.md:293`) | yes, rule 7 and `handleInbound` | general | MIT | already covered |
| Topic default holds until the user changes it (Courier `preferences.md:9`) | yes, round-5 rule 2 | general | MIT | already covered |
| Ask when the request is ambiguous (Courier `SKILL.md:15`) | no | general, but headless runs cannot ask | MIT | reject: our tasks are headless; use "record the assumption in the answer" |
| Skill does not fire on non-API requests, so the answer is plain Claude's (courier, skillCalls 0) | n/a | n/a | n/a | not copied; our skill fires (g1 to g4 in 3 of 3 runs, g5 in 0 of 3, both models) and costs one extra turn |
| Stay with what the request states, report a gap as a note (visible in courier g1 answers, not written in its text) | no | general | n/a | **adopt as our rule 11** |

Nothing is copied from either rival; no text or code is taken, so `THIRD-PARTY-NOTICES.md` does not change.

## 5. Second-best arms

Baseline (Sonnet 28.33): its extra turns are fewer (4.1 against our 5.9 per run) and it writes 86 lines against our 68. It loses points on g1 run 1 and g2 run 2 only. The
technique that makes it cheaper is not having a skill to load. Our lever is fewer turns after the skill loads: one file, one self-check run as an inline
command, no test file (decision d below). Knock (Sonnet 28.00): the opt-out note appears in its answers; same class as ours. No further gap.

## Decisions carried into the round-6 design (frozen in `docs/HEAD-TO-HEAD.md`, section "Round 6")

a. General rule (g1 class): every refusal must trace to the request or to a rule or legal text the request names, as a requirement on the sender before sending.
   A recommendation, a copy guideline, or a check on the message body is not a reason to block: record it and explain it in the answer.
b. Rule 7 is limited to opt-outs the data carries (an opt-out field or an inbound STOP), not to message wording.
c. Cost on Sonnet: shorter checklist, the self-check runs as one inline command, no extra test file.
d. Skill description line unchanged.
