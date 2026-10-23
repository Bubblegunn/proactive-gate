# Best-rival analysis, round 8 (2026-10-23): research and development, no measurement

Written and committed before any round-8 code change (`BEST-RIVAL-SPEC.md` steps 1 to 5), under the owner decisions of 2026-10-23 (research and development first, a
cheap development gate, one final measurement only when first place is nearly certain; launch claim I1 = the 95 percent bootstrap interval of ours minus the best other arm's
total lies above zero). No benchmark run, grading call or `claude -p` call was made for this round. Held-out sets that were never read stay sealed: no `heldout*` branch or folder
was opened. The two sets that were already read and burned (round-5 set g1 to g5, held-out c) are used only through the published tables and `BEST-RIVAL-round6.md` / `-round7.md`.

Sources: the published results (`bench/head-to-head/results/round5-heldout/SUMMARY.md`, `round5-heldout-sonnet/results.json`, `round6-heldout-c/SUMMARY.md`,
`round7-devgate/SUMMARY.md`, `NOTES.md`), the controller reports `proactive-gate-r5/r6/r7-report.md`, `docs/ROUND5-DIAGNOSIS.md`, `bench/head-to-head/tasks/Z.md` (the public criteria), and
rival texts read from `git archive` style copies in `/tmp/r6-rivals` (Courier skill, MIT, Copyright 2026 Courier, Inc.; Knock skills `cc99682`, MIT; both read, never run). Web sources are
listed at the end of each gap. Rival documents on the web were read as documents only.

## 1. Where we stand, in numbers (all from published tables)

| set, model | ours | best other arm | note |
|---|---|---|---|
| round-5 set, Sonnet (r5) | 27.00 | courier 29.00 (baseline 28.33, knock 28.00) | lost; ours 0.095 USD and 5.9 turns per run, baseline 0.093 USD and 4.1 turns |
| round-5 set, Haiku (r5) | 28.00 | 27.00 | ahead |
| held-out c, Haiku (r6) | 29.00 | baseline 28.00 | ahead in total, behind on g3 (opt-in block) |
| dev gate, three iterations (r7), ours only | Sonnet r5 28.00, 29.00, 30.00; Sonnet c 26.67, 28.00, 27.00 | n/a | a fix for one class created another each time |

Reading, without softening:

1. **The sets we were measured on are saturated.** On the round-5 set the plain baseline scores 28.33 of 30 on Sonnet. A launch claim of "total above the best other arm with an interval above zero" cannot be
   shown on a set where the best rival is at 29 of 30 and the maximum is 30: the interval of the difference includes zero unless we are at the ceiling in every run. Where an arm can win by a margin is a set
   that discriminates: the public set Z1 to Z6 (Sonnet baseline 24.00 of 36 in round 3, so there is room), and any development set built the same way. Round 8 therefore builds a discriminative development set (k) and
   targets the behaviours that cost every arm points there.
2. **On the saturated sets the only points anyone loses are lost to extra blocks.** In round 5 on Sonnet, g1 criteria 2 to 4 fail for ours 3 of 3, knock-inv 3 of 3, courier-inv 2 of 3, knock 2 of 3, baseline 1 of 3, courier 1 of 3; every one of
   them is a valid daytime text refused with `missing_opt_out_*`. The remaining baseline loss is g2 (one run: cap reset at local midnight and DST). The best rival on Sonnet (courier, 29.00) is plain Claude: `skillCalls` is 0 in 15 of 15 cells
   (`BEST-RIVAL-round6.md` section 2). So the primary rival is "Sonnet with no skill overhead and no invented block".
3. **Each of our rule-based fixes moved the loss, it did not remove it** (r7: iteration 2 added a legal-window default that held transactional texts at night in 6 of 6 cells; iteration 3 narrowed it and it then held email and g5 texts).
   Prose rules that say "block when X" are read by the model as "block more". The product has to add value in a form that cannot be over-read: tested code the agent reuses, and rules that only say what a refusal must carry.

## 2. What the best rivals do (evidence, file:line or URL)

Courier (primary rival on Sonnet; MIT):
- A delivery window delays to the next open time and does not drop: `skills/courier/references/guides/scheduling.md:13` ("A send outside the window isn't dropped. It waits."), `:57` (sends now inside the window, otherwise waits for the next open slot),
  `:63-67` (the window is an expression with an IANA zone), `:71` ("Start is inclusive; end is exclusive").
- Zone resolution order: `scheduling.md:77-80`: delay zone, then `message.to.timezone` or profile `zoneinfo`, then profile `timezone`, then UTC. The fallback to UTC is a send at the wrong local hour; we hold instead (rule 6).
- Time-critical sends skip the window: `guides/patterns.md:11` (OTP, reset, security alerts). Same as our rule 9 transactional exception. Transactional sends still honour channel preferences: `transactional.md:14` (same as our rule 9: the channel's own opt-out still applies).
- Show times to the person in their zone: `transactional.md:13` ("Render times in the recipient's timezone with the abbreviation (`2:00 PM PST`), never in server time").
- Frequency caps and throttling live in the vendor, not in app code: `guides/throttling.md` ("Rebuilding rate limiting in application code" is listed as a common mistake); a blocked message ends `THROTTLED` and "doesn't send later". There is no
  local-day or local-week cap; windows are rolling.
- Courier's text never says to add a block the request did not state; this is what plain Sonnet already does.

Knock (MIT):
- Throttle: https://docs.knock.app/designing-workflows/throttle-function (read 2026-10-23): window opens at the first execution (rolling, not a calendar day), threshold default 1, key `concat(recipient_id, throttle_key)`;
  a missing or invalid dynamic window or key logs an error and **skips the throttle** (fails open). Only "window rules" are zone-aware, resolved recipient zone, then account default, then `Etc/UTC`.
- Rules in the skill text: `rules/notification-system-implementation.md:30` ("Respect user preferences and quiet hours"), `:213` ("Quiet Hours -> Delay until appropriate time").

Novu (MIT core; enterprise folders excluded):
- Scheduled delay is evaluated "in the subscriber's local time zone"; "Extend to subscriber's schedule" holds delivery to the next available window (https://novu.co/changelog/scheduled-delay/, read 2026-10-23). Subscriber schedule: per day of week, several ranges
  per day, zone detected from the system, critical notifications exempt (https://docs.novu.co/platform/inbox/features/schedule). Throttle step: per subscriber, fixed or dynamic window, grouping key (https://novu.co/changelog/category/workflow-steps/).

OneSignal: frequency capping is a rolling window per user, over-cap messages are dropped, not queued (https://documentation.onesignal.com/docs/frequency-capping). "Optimize by user time zone" sends within each device zone. No quiet-hours setting in its own documentation.

Vendors of TCPA tooling (Sonar, https://docs.sendsonar.com/docs/intelligent-timezone-compliance): zone order manual value, then ZIP, then area code; with only an area code, send in a narrower window (their example 11:00 to 17:00). Cordial's quiet hours page adds
a state exception (Texas Sunday). Secondary sources list stricter state windows (Florida, Oklahoma and Maryland 08:00 to 20:00; Texas 09:00 to 21:00 Monday to Saturday and 12:00 to 21:00 Sunday) which I could not confirm from statute text in this session (see gap 8).

Cross-vendor summary (https://www.courier.com/blog/quiet-hours-delivery-windows): zone from message, then profile, then system default; defer, not drop (Courier, Customer.io, Knock queue; Braze lets you choose); urgent exemption per node; per-channel windows are rare (Braze,
Knock), reasoning: "a 10pm push is invasive in a way a 10pm email isn't". The article does not cover DST, expiry of a deferred message or batching.

Public benchmarks of the category: none covers gating. ProAgentBench (arXiv 2602.04482) scores "when to assist" as binary classification on collected user data; ProEvent (arXiv 2607.17701) scores timing and correctness of reactions to chats and reports that agents
"overact" (GPT-5.1 correct in 26.7 percent of scenarios); a position paper (arXiv 2605.06717) says no benchmark evaluates timing, framing and silence together. No dataset with quiet hours, consent, STOP or budgets exists in them, and the data licences are not stated on the pages read. Nothing to
adopt; "agents overact" matches our own loss class (extra blocks).

## 3. Why Sonnet's plain answer beats ours, class by class (from the published cells)

| class | evidence | who loses |
|---|---|---|
| A block the request does not state (opt-out notice, "no opt-in on record", legal window default) | r5 g1, c g3, r7 iterations 2 and 3 | ours, and every arm with a skill; baseline and courier less |
| Extra turns and typed code (skill load, scaffold read, tests) | r5 Sonnet: 5.9 turns against 4.1; r3: 11.8 against 3.7 | ours (cost rule) |
| Hand-written local-day, DST and next-allowed time maths | r5 g2 baseline 1 of 3 (cap reset, DST); Z2 c1 edges, Z6 c2 `availableAt` fail in 1 to 3 arms | the baseline and the rivals, not us when the maths is right |
| Behaviour nobody states: local clock time in the refusal text, a suppression that ends at the next local day, "drop the push, keep the in-app item" | Z6 c3 fails 9 of 9 cells of three arms; Z5 c3 and c6 fail 3 of 3 in all arms (round-5 diagnosis, `ROUND5-DIAGNOSIS.md` section 1) | every arm |

The last two rows are where a product can win without adding any block: it is correct code and correct refusal content, not more refusals.

## 4. Technique map

| # | technique | do we have it | general or task-specific | licence | decision |
|---|---|---|---|---|---|
| G1 | No default block the request does not state (plain Claude, Courier text silent on blocks) | rule 11 (partial); rule 6 last sentence adds a block | general | n/a | **adopt**: remove the legal-window default from rule 6 (measured regression, r7 iterations 2 and 3); keep rule 11 |
| G2 | Defer to the next open time; start inclusive, end exclusive (Courier `scheduling.md:13,57,71`; Novu scheduled delay) | rules 6 and 8 in prose; no tested code | general | MIT, MIT | **adopt as tested code**: `gkNextOpen` in the kit, DST-correct, wrap-around, nonexistent local times |
| G3 | Calendar-day and week budgets in the recipient's zone, atomic across processes | prose (rules 4, 5) | general | n/a (Courier and Knock use rolling windows, which is weaker) | **adopt as tested code**: `gkDayKey`, `gkWeekKey`, `gkNextMidnight`, `gkCount`, `gkClaim` |
| G4 | Time shown to the person in their zone (Courier `transactional.md:13`) | no | general | MIT | **adopt the idea**: refusal text names the retry time as a local clock time plus the zone name, never as an ISO string or "UTC" alone; the instant is returned as a separate field. Kit: `gkFmt` |
| G5 | Per-surface hold: quiet hours and caps hold the interrupting surface (push, SMS, call) while a silent in-app item stays (Braze and Knock per-channel windows; Z3 c2 and c4, Z5 c6) | partly in the library, not in the inline rules | general | n/a | **adopt** as one sentence in rule 6 |
| G6 | A suppression key (insight, dismissal, snooze) ends at the next local day unless the request says longer (Z5 c3) | no | general | n/a | **adopt** as one sentence in rule 5 |
| G7 | Critical or transactional messages skip windows and caps, but not their channel's opt-out (Courier `patterns.md:11`, `transactional.md:14`; Novu critical exemption) | rule 9 | general | MIT, MIT | already covered; keep as is |
| G8 | Zone fallback chain ending in a default zone or UTC (Courier `scheduling.md:77-80`, Knock) | no (we hold on an unknown zone) | general | MIT | **reject**: a send at the wrong local hour is the failure the product exists to prevent; the checker Z1 c3 also requires "not sent" with no usable zone |
| G9 | Zone from ZIP or area code with a narrower window when only a phone number is known (Sonar) | no | general | proprietary docs; `libphonenumber` timezone mapper is Apache-2.0 (Python `phonenumbers`) | **reject for the skill** (no table in a 8 KB inline skill; a guess is a guess). Note for the library roadmap |
| G10 | Throttle that fails open on a bad key or window (Knock) | no | general | MIT | **reject**: ours fails closed |
| G11 | Rolling-window caps (Knock, OneSignal, Courier) | no | general | n/a | **reject** as the default: the product counts the recipient's calendar day and week, which is what a person means by "per day" |
| G12 | Weekly schedule with several ranges per day (Novu Inbox schedule) | `quietHours` is one range per user | general | MIT | **reject for now**: library-level feature, not an inline-skill topic |
| G13 | State windows stricter than the federal 08:00 to 21:00 (FL, OK, MD 20:00; TX Sunday) | no | legal data | secondary sources only | **reject for now**: not verified against statute text; the request's own text decides a narrower window (rule 6). Open item for the owner |
| G14 | Fewer turns and less typed code than the baseline (cost rule) | skill load costs a turn; scaffold read cost 12.9 tool calls in round 5 | general | n/a | **adopt**: the verified helpers are appended to the file by one shell command, so the agent types the policy, not the maths; the hook line stops pointing at the library |
| G15 | Public benchmarks (ProAgentBench, ProEvent) | n/a | n/a | not stated | nothing to adopt |

Nothing is copied from a rival: the kit is new code; Courier's inclusive-start, exclusive-end convention and delivery-window semantics are used as an idea only (it is also the rule in our own rule 6). `THIRD-PARTY-NOTICES.md` does not change.

## 5. Second-best arms

Baseline and knock lose points on the same extra-block classes (r5 g1 for knock 2 of 3 runs) and on hand-written local-day maths; the changes above only remove a block, add tested maths, and add refusal content. None of them opens a gap to Knock or to the baseline. The courier-invoked arm scores 28.00 on
Sonnet and loses on g1 (2 of 3) for the same block.

## 6. Design (frozen before code; ruling log)

Rulings (each is general; none edits a task, criterion, checker or the win rule):

- R8-1. Rule 6 loses its last-added sentence ("When the request asks for care about contact hours and states none, use the legal window ..."). Evidence: r7 iteration 2 (transactional text at night, 6 of 6 cells) and iteration 3 (email and g5 texts held for legal hours). The owner recommended removal in the r7 report.
  Effect: back to the iteration-1 behaviour plus the rule-9 transactional exception, which measured best (r7 iteration 1: r5 Haiku 29.33, c Haiku 28.33).
- R8-2. A tested helper file `skills/proactive-gate/references/gate-kit.mjs` (plain ESM, no dependency, names prefixed `gk`). The skill tells the agent to append it to its own file with one shell command and call it. For a non-ESM target the agent writes the logic by hand as before.
- R8-3. The refusal sentence (rule 8) names the retry time in the recipient's local clock (24-hour HH:MM and the zone name) and the same instant as a separate machine field. Never an ISO string or "UTC" inside the sentence.
- R8-4. Rule 6 gains: a hold from quiet hours, a window or a cap applies to the interrupting surface (push, SMS, call); a silent in-app or feed item for the same message is still produced when the app has one.
- R8-5. Rule 5 gains: a suppression (same key shown, dismissal, snooze) lasts until the end of the recipient's local day unless the request says longer.
- R8-6. The skill stays within 9,000 bytes including the kit API lines (round-7 build: 7,668; amended from 8,000 before any code change: the kit listing and the three added sentences need about 1,300 bytes, which as cached input costs about 0.0001 USD per turn on Sonnet, far below the output tokens the kit saves). Rules 2 and 11 are compressed without changing their cases; skill test pins are updated.
- R8-7. The `UserPromptSubmit` hook line stops saying "and its library instead of hand-written rules" (it pushed the agent to the 12.9-tool-call library path). It names the skill only.
- R8-8. A new development set k (5 tasks, checkers, labels, references, written by a fresh Sonnet agent that saw only the README sentence, the task template and a list of difficulty areas, never the product code) is committed before any run. Its `lib.mjs` loads each criterion with a fresh module instance
  (`crypto.randomUUID()` in the cache-busting query), so the race found in r7 does not touch it. The old checkers are untouched (owner decision pending).
- R8-9. Every new test has a mutation check (a mutant of the kit that must make it fail, applied in memory by the test itself).

## 7. Implementation plan

Method: superpowers subagent-driven-development; Haiku 5.5 implementers one at a time, Sonnet 5.5 reviewers; tests, mutation checks, `npm run lint`, `npm test`, `claude plugin validate . --strict` (profile directory); one commit per task; push to `origin plugin-leadership` after each reviewed task.

| task | files | tests | closes |
|---|---|---|---|
| T1 kit | `skills/proactive-gate/references/gate-kit.mjs`, `test/gate-kit.test.mjs`, `package.json` (test list) | DST gap and fold (New_York 2026-03-08 and 2026-11-01, Lord_Howe, London), window edges and wrap, next open, day/week keys, next midnight on 23 and 25 hour days, STOP/START parsing, atomic count and claim under 2 processes x 12 calls, a mutation harness | G2, G3, G4 |
| T2 skill | `skills/proactive-gate/SKILL.md`, `test/skill.test.mjs` | pins: size cap, kit path variable, every kit name the skill mentions exists in the kit, rule 6 has no legal-window default, rule 8 names local time | G1, G4, G5, G6, G14 |
| T3 hook | `hooks/trigger.sh`, `test/trigger-hook.test.mjs` | the output line text; still silent on unrelated prompts | G14 |
| T4 dev set | `bench/head-to-head/dev/k/` (prompts, checkers, refs, labels, TASKS.md), `docs/DEV-GATE-round8.md` | the checkers run on the writer's references: good 6 of 6, broken ones fail as intended; run twice for determinism | development gate |
| T5 proposal | `docs/DEV-GATE-round8.md` | none (document) | protocol, call estimate |

Out of scope and left to the owner: moving the kit into the npm package's public API, state-law presets (G13), fixing the old checker race.
