# Round 5 diagnosis (2026-10-22): where the plugin loses to plain Claude on Z1 to Z6, Haiku

Produced by a read-only Sonnet analyst (claude-sonnet-5-5) from the round-4 transcripts and a same-environment baseline
diagnostic run (`bench/head-to-head/results/round5-diag-haiku/`, 18 cells, diagnostic only, not part of any gate). The
analyst was told not to change anything. File and line references point at the repository state of commit `c3a9c65`.
The analyst reports no `knock` cells in any results file (round-4 `knock` cells were reused from round 3, whose per-run
transcripts are not in the repository), so nothing here is a measurement of Knock.


Shorthand. H = proactive-gate/bench/head-to-head. B2 = H/results/round4-haiku-b (ours build 2). BL = H/results/round5-diag-haiku (baseline).
CO = H/results/round4-haiku (courier, courier-inv, ours build 1). Code: work/<run>/bot.mjs. Transcripts: runs/<run>.jsonl.
Totals (mean of 3 runs, summed over six tasks): ours-b2 22.67, baseline 24.67, courier 24.67, courier-inv 23.33, ours build 1 20.00.

## Limits of the comparison

1. There is NO knock arm in any results.json (0 rows). Nothing can be said about Knock's score; only its text is read in section 4.
2. The "courier" arm never called the Skill tool (skillCalls 0 in 18 of 18 runs). It is plain Claude with a plugin loaded, and its 24.67 equals baseline's.
   "courier-inv" invoked the skill in 11 of 18 runs and scored 23.33, below baseline. No result shows a competitor's text raising a score.
3. Cost is not comparable across rounds (baseline 0.017 USD per run vs courier 0.21 at the same 8 turns). Use turns, lines and tokens (section 3).

Mean score per task (ours / baseline / courier): z1 5.33/6.00/5.67, z2 2.00/4.33/5.00, z3 3.00/4.33/4.00, z4 4.00/2.00/2.00, z5 4.00/3.33/4.00, z6 4.33/4.67/4.00.
Ours minus baseline: z1 -0.67, z2 -2.33, z3 -1.33, z4 +2.00, z5 +0.67, z6 -0.33 (net -2.00).
The deficit is concentrated in three runs that scored 1 of 6: z2-1, z2-3, z3-3.

## 1. Failed criteria, runs failed out of 3 (ours-b2 / baseline / courier)

Numbers follow tasks/Z.md. Only criteria that failed in some arm are listed.
- **z1**: c1 marketing 0/0/1; c2 opt-out survives new process 2/0/0.
- **z2**: c1 window 2/0/0; c2 STOP words 3/3/3; c4 optOut route 3/0/0; c5 dedupe 2/0/0; c6 stale digest 2/2/0. (c3 passes everywhere.)
- **z3**: c1 dismissals 1/0/0; c2 categories missing 3/2/1; c3 failed push does not spend 2/2/3; c4 consent store throws 1/1/2; c5 permission reason 1/0/0; c6 snooze 1/0/0.
- **z4**: c1 ramp uses account age 3/3/3; c3 requested held at 03:00 1/3/3; c4 cap 1/3/3; c5 reminders 1/3/3.
- **z5**: c1 thin account 0/2/0; c3 next-day re-show 3/3/3; c6 dismissed hour keeps in-app 3/3/3.
- **z6**: c2 availableAt 2/1/3; c3 local time in text 3/3/3.

### Concrete causes where ours fails and another arm passes

**z1 c2 (ours-z1-1, z1-2).** The store is bound at first use.
- B2/work/ours-z1-1/bot.mjs:13 `let runtime; // ... created on first use so STATE_DIR is read then`; :16 `if (runtime) return runtime;`. z1-2 :30-31 `function open() { if (state) return state;`.
- The checker sets a fresh STATE_DIR per criterion inside one process (H/checkers/z1.mjs:34-39). The in-process optOut goes to the first criterion's database; the new process reads the new directory and allows the user ("second process allowed the opted-out user").
- ours-z1-3 passes because it keys the cache by directory: work/ours-z1-3/bot.mjs:17-20 `if (state && state.dir === dir) return state;`.
- Baseline reads the variable per call: BL/work/baseline-z1-1/bot.mjs:160 `const dir = process.env.STATE_DIR;` inside `stateRoot()`.
- Source of the pattern: SKILL.md:27 and src/scaffold.ts:19, "read at first use". Partly a checker artifact (no real app changes STATE_DIR), but it costs two z1 points.

**z2 c1, c4, c5, c6, and the "revoked" part of c2 (ours-z2-1 and z2-3, 1/6 each).** Missing consent field read as "no consent", so nothing is ever sent.
- z2 data is `{ id, timezone }`; the prompt has no consent field.
- B2/work/ours-z2-1/bot.mjs:12 `{ id: "consent" },` with no consent on the input user. B2/work/ours-z2-3/bot.mjs, in toInput: `consent: user.consent === true,`. Every call returns "Held because the user has not agreed to proactive messages."
- z2-3 final message (runs/ours-z2-3.jsonl line 52): "The proactive-gate skill says `requested` avoids this; that is wrong for this check, so I did not use it." z2-1 (line 63) says the same.
- The agents are right. SKILL.md:26 says setting `requested` stops the missing-consent hold. In the library `consent()` ignores it: src/checks.ts:298 `return user.consent ? pass : reject(...)`. The scaffold sets consent only from `granted` (src/scaffold.ts:51, :66-67). `requested` only exempts the separate `requiresConsent` check (src/checks.ts:1013-1016).
- z2-2 left the consent check out (work/ours-z2-2/bot.mjs:10-18: freshness, usTcpa, dedupe, weeklyBudget) and scored 4. No baseline or courier z2 bot mentions consent at all.

**z2 c4 (ours-z2-2).** Same first-use binding: work/ours-z2-2/bot.mjs:33 `if (runtime) return runtime;`. Crit 3 uses only subprocesses and passes; crit 4 mixes an in-process optOut with a subprocess read and fails.

**z3 c1, c2, c5, c6 (ours-z3-3, 1/6).** Invented consent purpose. work/ours-z3-3/bot.mjs:8 `const CONSENT_PURPOSE = "proactive";`, :59 `consent = consents?.[CONSENT_PURPOSE] === true;`. The checker's store returns `{push, marketing, analytics, briefing}` (H/checkers/z3.mjs:19), so no case ever gets push or in-app.

**z3 c2, c4 (ours-z3-1).** Scaffold bug copied. work/ours-z3-1/bot.mjs:110 `inApp = Boolean(await transport.inApp(user, candidate));`. The prompt says inApp "resolves when the in-app item is stored" (no value), so inApp is always false. Origin: src/scaffold.ts:145. z3-1 is the only run that opened scaffold.js (runs/ours-z3-1.jsonl line 35).

**z3 c2, c3 (ours-z3-2).**
- work/ours-z3-2/bot.mjs:62 `const surfaces = user.notificationsPermitted === false ? ["feed"] : ["push", "feed"];` decides push from permission only, so missing `categories` still pushes.
- :124 and :128 `if (!push && !inApp) await gate.release(decision, input);` gives the budget back only when nothing was delivered. With the in-app item stored, a refused push keeps the claim, so attempt 3 is blocked ("push false, want true").
- The scaffold does it right (src/scaffold.ts:147 releases on a refused push even if in-app was stored), but no run used the scaffold.

**z6 c2 (ours-z6-2, z6-3).** Delivered entries carry an availableAt: work/ours-z6-3/bot.mjs:132 `availableAt = at.toISOString();`. Baseline z6-2 and all 3 courier runs share the defect, so ours is only one run worse.
**z6 c3.** ours-z6-1:111 puts an ISO time in the text; c3 fails in all 9 runs of the three arms anyway.

**z4 (ours better than baseline; ours' own losses).**
- ours-z4-2 :78-80 `// The app supplies no consent field...` then `consent: isInferred ? user.consent === true : true,`. Every suggestion is refused as NOT_CONSENTED, which fails c1, c4, c5.
- ours-z4-3 :101 `quietHours: isNudge ? NUDGE_QUIET_HOURS : undefined,` lets a requested notice out at 03:00 (c3). Baseline and courier fail c3 in 3 of 3, so this is no loss.
- c1 fails everywhere (ours-z4-2 :68-71 takes `Math.max` of createdAt and profileCreatedAt, the same mistake baseline makes).

## 2. General classes of "ours worse than plain Claude"

Supported:

**A. Wrong default for data the task does not carry (consent). Largest effect.**
- 4 runs: z2-1, z2-3, z3-3, z4-2. Each wrote "absent consent = no", or invented a purpose name, where the task data has no such field.
- z2-1 and z2-3 shipped a bot that refuses every send and said so only as a caveat ("nothing will send until..."). z3-3 invented `consents.proactive`.
- Contrast z1, where the data carries `consents` and "absent = off" is right: ours does well there.
- The skill's own remedy is false (SKILL.md:26 vs src/checks.ts:298). A stronger agent could not have found a working path from the skill text.
- Estimate: if z2-1, z2-3 and z3-3 had scored like their sibling runs (about 4), ours gains about 3 points (z2 +2.0, z3 +1.0), plus 0.3-0.7 if z4-2 is fixed. That would put ours near 26, above baseline's 24.67.

**B. State and process handling: store bound at first use.** 3 runs (z1-1, z1-2, z2-2), 3 criteria. Partly a checker artifact, but every baseline and courier bot reads STATE_DIR per call, and one ours run re-keys by directory and passes. Cheap to fix.

**C. The skill path gives a worse design than hand-writing, because the scaffold is not used.**
- 0 of 15 skill-invoked runs ran `npx proactive-gate scaffold` (checked by search over all tool calls). The agents assemble a policy from the check catalogue and write their own commit/release logic.
- z3-2 lost the refund on a refused push, which the scaffold has. z3-1 copied a scaffold bug. Hand-assembled check lists add defaults the task never asked for (consent in z2-1, z2-3, z3-3, z4-2).

**D. Extra turns and context.** Real (section 3) but not itself a cause of lost points. The extra reading did not prevent A, B or C, and the agents' own checks (130 self-written test calls over 15 runs) tested their assumptions, not the prompt's data shape.

Not supported, dropped:
- **Too much code or scaffolding.** Ours writes less: mean 121 lines vs baseline 230 (z1 103 vs 326, z6 179 vs 356).
- **Wrong time-zone or window defaults.** z1 c3 passes 3/3 for ours. z2-2 passes the window edges; the other z2 window failures are the consent refusal. In z4 c3 ours fails once, baseline three times.
- **Where ours is better:** z4 (+2.0) comes from `dailyBudget` with priority "high" and `kind: "commitment"` for requested and reminder candidates. z5 (+0.67): ours had no skill call there (0 of 3), so it is plain Claude; baseline's loss is c1, thin accounts.

## 3. Cost

Mean turns / cost USD / lines per task (ours-b2, baseline, courier; courier = plain Claude with plugin listed).

| task | ours | baseline | courier |
|---|---|---|---|
| z1 | 20.3 / 0.433 / 103 | 7.3 / 0.018 / 326 | 8.7 / 0.225 / 240 |
| z2 | 23.3 / 0.356 / 80 | 6.7 / 0.015 / 166 | 9.3 / 0.198 / 194 |
| z3 | 26.0 / 0.543 / 123 | 6.7 / 0.021 / 226 | 8.0 / 0.253 / 271 |
| z4 | 18.3 / 0.333 / 106 | 7.3 / 0.012 / 177 | 6.3 / 0.154 / 157 |
| z5 | 6.7 / 0.113 / 134 | 6.0 / 0.009 / 131 | 5.3 / 0.117 / 141 |
| z6 | 21.7 / 0.465 / 179 | 12.0 / 0.026 / 356 | 9.7 / 0.323 / 368 |
| all | 19.4 / 0.374 / 121 | 7.7 / 0.017 / 230 | 7.9 / 0.212 / 228 |

- Mean seconds: ours 133, baseline 97, courier 102.
- Tool calls before the first Write (skill tasks, 15 runs): ours 12.9, baseline 1.7, courier 2.5. After it: 7.1, 5.3, 4.9.
- Token check: ours-z2-2 read 1.39M cache-read tokens and wrote 29k output; baseline-z2-1 read 0.16M and wrote 17k (about 8 times the context).

**ours-z2-2, 24 tool calls (runs/ours-z2-2.jsonl):** Skill; Bash node -v/ls; Bash ls of the _setup skill folder (twice); Bash npm install; Read guide.md; Read checks.md; Bash ls dist/src; Bash cat presets.js; Bash cat inbound.js/stores.js/gate.js (three times, two with wrong paths); Bash grep consent/weeklyBudget in checks.js; **Write bot.mjs (13th call)**; Edit; then Bash write worker.mjs (twice), write test.mjs, sed fix of the test clock, Edit, run test, Read test.mjs, Edit, run test with node --check.
- 13 calls before the first Write, mostly compiled library source and path errors. About 8 calls after it were test-script fixes.

**ours-z1-1, 12 tool calls (runs/ours-z1-1.jsonl):** Skill; Bash node -v/pwd/ls; Bash ls of the _setup path; Bash ls node_modules/proactive-gate/skills; Bash cat skill files; Bash cat checks reference; Bash cat store-contract.d.ts; Bash grep "interface Store"; Bash grep killSwitchFlag; Bash cat index.d.ts; **Write**; Bash run its own test.
- 10 of 12 calls are reading. No `scaffold` call.

Pattern over the 15 skill runs: 153 calls touch library or skill files, 130 are self-written checks, 17 are `npm install`. The main extra cost is learning a many-check library from compiled source, because SKILL.md points to references rather than giving the shape.

## 4. Competitor methods (read only, never run)

Courier = /tmp/r5/ref/courier/skills/courier. Knock = /tmp/r5/ref/knock/skills. Both are API-product skills (send through their service). Neither tells an agent what to do when the app's data lacks a consent field.

**(a) Missing or unknown consent or preference data**
- Courier references/guides/preferences.md:9: "A user preference is an override on a topic's default, not a standalone value." Lines 68-69: On default means "Users receive these unless they opt out". So absent means the product's topic default.
- Courier SKILL.md:124: "Only send to channels the user has asked for or that make sense for the use case."
- Knock rules/relevance-and-preferences.md:80: "Defaults should match role and product use — not 'everything on.'"
- Knock rules/notification-system-implementation.md:30: "Respect user preferences and quiet hours".

**(b) Quiet hours and time zone**
- Courier references/guides/scheduling.md:13: "A delivery window delays until the *next* open time. A send outside the window isn't dropped. It waits." Lines 75-79: zone order is delay.timezone, then `to.timezone` or profile `zoneinfo`, then profile `timezone`.
- Courier SKILL.md:129: "Use a native delivery window, not app-side queueing". Courier channels/sms.md:380: "To hold non-urgent SMS outside a window, use a delivery window."
- Knock notification-system-implementation.md:151: "Quiet hours respect". Knock delivery-strategy.md:72: "Respect time zones and working hours."
- Neither says "unknown zone means hold" or "device zone before saved zone"; ours does (SKILL.md:28).

**(c) Opt-out and STOP**
- Courier channels/sms.md:289: "STOP, UNSUBSCRIBE, CANCEL, END, QUIT | Unsubscribe"; lines 283-293: write the provider's STOP into the user's preference. sms.md:10: "Your SMS provider handles STOP, not Courier."
- Knock notification-system-implementation.md:394: "Honor opt-out immediately" (TCPA list, lines 391-395); line 225 lists "Unsubscribed user" as a hard failure, not retried.
- The keyword list equals our src/inbound.ts:5. Neither lists "Revoke" or "opt out", which every arm fails in z2 c2.

**(d) Caps, dedupe, idempotency**
- Courier references/guides/reliability.md:8: "ALWAYS use idempotency keys for transactional notifications"; lines 26-31: key off a request id, not a timestamp. SKILL.md:122: "Use idempotency keys for sends where duplicates would be harmful".
- Courier references/guides/throttling.md:7: send limits "cap how many messages a user, topic, or tenant gets in a time window"; blocked messages are not sent later.
- Knock notification-system-implementation.md:177: "Maximum per day by category". Knock rules/volume-and-batching.md:24-25: "Per-workflow limits" and "Cooldowns."
- All of this is service-side. Nothing covers a refused send not spending the budget (z3 c3) or counting on the local day.

**Do these methods explain a higher score?** Mostly no.
- The courier arm did not load its skill in any run; its score is plain Claude's. courier-inv, which did, scored lower than baseline.
- Courier beats ours at z2 (5.0 vs 2.0), but none of its z2 bots has a consent check, and 3 of 3 courier z2 runs did not use the skill. That is the absence of our failure, not a courier method. courier-inv z2 (4.33, skill in 2 of 3 runs) also has no consent check.
- The only plausible credit is (a): "a topic default applies until the user changes it" fits treating a signed-up digest as opted in. That is a general principle, not a rule written for this case.
- Knock: no arm, so no claim.

## 5. Design implications

1. **Fix SKILL.md:26.** `requested` does not clear the consent hold (src/checks.ts:298, src/scaffold.ts:67). Make it true (let `requested` or a commitment satisfy `consent()` and set consent in toInput when the app carries no consent field), or tell the agent to leave the consent check out. Evidence: z2-1 and z2-3 quote the line and drop it; z2-2, with no consent check, scored 4.
2. **State when "absent = off" applies.** Use it where the task data carries the field (z1 passes); where it does not (z2, z3, z4) the sign-up is the opt-in. Evidence: runs z2-1, z2-3, z3-3, z4-2, about 3 points.
3. **Forbid invented keys.** Read only keys that appear in the task data (`consents.briefing`, `consents.marketing`), never `consents.proactive` (z3-3:8,59).
4. **Make the scaffold the real path, or put its rules in SKILL.md.** 0 of 15 runs used it; the agents spend 12.9 tool calls on compiled source first. The rules to carry: refund on a refused push (z3-2:128), opt-out store, consent mapping.
5. **Fix src/scaffold.ts:145.** Set `inApp` true when `transport.inApp` resolves, whatever it returns. Evidence: z3-1 lost c2 and c4.
6. **Key the cached store by STATE_DIR** in SKILL.md:27 and scaffold.ts:19. Evidence: z1-1, z1-2, z2-2 fail; z1-3 does this and passes.
7. **Add REVOKE and OPT OUT to STOP_KEYWORDS** (src/inbound.ts:5; the TCPA text in tasks/Z.md names them). Evidence: z2 c2 fails in all 9 runs of ours, baseline and courier.
8. **Require a check against the prompt's data shape.** Call the exported function with only the fields the prompt lists and confirm at least one send is allowed. Evidence: z2-1 and z2-3 shipped bots where every real call refused.
