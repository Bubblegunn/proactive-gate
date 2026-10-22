# Round 4 research: competitors and techniques for proactive-gate

Date of research: 2026-10-22. Author: research agent (Sonnet 5.5). Nothing downloaded was executed. Clones are under
`pg-research-out/clones/` (knock-skills, courier-skills, aaron-marketing-skills, notifkit, notifyd), all `git clone --depth 1`.
No maintainer was contacted. The Vaara plugin was not installed or run (see Sources: it is a security-governance plugin, not a competitor).

## Scope and method

Question: which alternatives solve the same user problem (a developer adds a correct send-or-stay-silent gate: consent,
opt-out, quiet hours, caps, dismissal fatigue, kill switch, idempotent redelivery, audit reasons, dry run), and what
techniques can proactive-gate take from them.

What I did:
- Read the product files: `skills/proactive-gate/SKILL.md`, `src/stores.ts`, `src/scaffold.ts` (first 240 lines), grep of `src/gate.ts`, `bench/head-to-head/tasks/Z.md`.
  I did NOT read `README.md` or the full `src/gate.ts`. I did NOT find round-3 per-task outputs or checker logs in the repo
  (`bench/head-to-head/results/` holds round 1-2 setup packs only; `ls` was blocked), so every explanation of "why knock beat us" in
  section "Knock vs ours per task" is a hypothesis from code and task text, not from run logs. Verify each against the checker output before acting.
- Note: `src/scaffold.ts` changed on disk while I was reading it. My first read showed `STATE_DIR` read at import time
  (cause 1 of round 3). My later read showed a lazy `current()` store keyed by `process.env.STATE_DIR` (scaffold.ts lines 19-29).
  So the lazy fix for Z4 is already in the working tree; I do not know if it is committed or covered by a test.
- Searched (web search, GitHub pages, GitHub API, skill directories): GitHub, awesome-lists, skill directories (skillsdirectory.com,
  claudemarketplaces.com), npm/PyPI via web search, arXiv via web search, Hugging Face via web search.
- Not done: `claude plugin list --available --json` (not run; Bash needs approval for compound commands and I judged the
  web listing sufficient), direct npm/PyPI registry queries, direct Hugging Face Hub search, `anthropics/claude-plugins-official` tree listing.
  A negative result below means "not found by web search", not "does not exist".
- Hugging Face: the one web search returned no model, dataset or Space for this problem. arXiv: papers exist on proactive-agent
  interruption timing (listed in Sources) but none ships an installable send-or-stay-silent gate.

## Competitor ranking

Ranking criterion: closeness to "agent-installable help for adding a notification gate" first, then runnability as a benchmark arm.

| # | Name | URL | License (SPDX) | Version / date | Runnable as arm? |
|---|------|-----|----------------|----------------|------------------|
| 0 | Knock skills (already covered) | https://github.com/knocklabs/skills | MIT (LICENSE file read) | commit cc99682ed74ee34198602c7d28569bd1c5f309d3, 2026-09-30 | Yes, already used in round 3 |
| 1 | Courier skills | https://github.com/trycourier/courier-skills | MIT (LICENSE read) | commit 18c7bcbeee6d5deb58a0d9dfec9ded4f960b2132, 2026-10-22T03:03Z | Yes, skill-only. See below |
| 2 | notifkit (library + MCP) | https://github.com/devkitshq/notifkit | MIT (LICENSE read) | commit 5f109943accbde7e011194ecc3ad6ad5a9993ee7, 2026-10-19 | No as skill-only arm: needs PostgreSQL + Redis, Node 22, a running service |
| 3 | aaron-marketing-skills, skill `email/nurture/preference-frequency-manager` | https://github.com/aaron-he-zhu/aaron-marketing-skills | Apache-2.0 (from GitHub page) | commit 79c145da991dd00dad3c0b94b23a18ef27482456, 2026-10-22T11:00Z; repo moves daily, 536 commits | Yes, single skill folder, but weak fit (marketing-email strategy, no code) |

Considered and rejected as top 3:

| Name | URL | License | Why not |
|------|-----|---------|---------|
| notifyd (Rust service, MCP at /mcp) | https://github.com/rmzlb/notifyd | MIT (LICENSE read) | Commit 1767a73b4735642d9f5de7d5dc09f71640757d50, 2026-10-21. Self-hosted service, needs PostgreSQL, JWT secret, admin key. Has quiet hours per subscriber timezone, rate limit, per-topic opt-out, idempotency migration. 17 stars. Not a skill-only arm |
| OneSignal agent plugin | https://github.com/OneSignal/onesignal-agent-plugin | not checked | Commit 8133b2781bdc47ebbca2a186370537f98e41e10d, 2026-10-15. Three skills (setup, credentials, verify) for a OneSignal account. Needs the paid/hosted service; no gate logic |
| modbender `notify` skill | https://www.skillsdirectory.com/skills/modbender-notify (source: github.com/modbender/skill-library-mcp, data/notify/SKILL.md) | not stated on the page | Short rules: quiet hours 23:00-08:00 user timezone, max 3 reminders, batch 3+ within 5 min. No opt-out, no dedupe. License unknown, so do not redistribute |
| gbrain cron-scheduler | https://skills.sh/garrytan/gbrain/cron-scheduler | not checked | Quiet-hours hold queue for scheduled jobs only. Tessl security scan flagged one medium item (per search summary, not verified) |
| Novu, SuprSend, MagicBell | https://novu.co | not checked | Hosted/service products; I found no SKILL.md repo for them by web search |
| Braze / Bird / Cordial quiet-hours docs | https://www.braze.com/docs/user_guide/messaging/messaging_fundamentals/quiet_hours | proprietary docs | Useful as design references (see Techniques), not installable |

Per-candidate notes (all from files I read unless marked):
- **Courier skills.** One skill `skills/courier` (SKILL.md 248 lines, `license: MIT` in frontmatter) plus `references/` guides,
  including `guides/throttling.md`, `preferences.md`, `scheduling.md` (delivery window = quiet hours), `reliability.md` (idempotency keys),
  `digests.md`, `batching.md`. Its SKILL.md tells the agent "Route first... Don't read the tree": read 1-2 files per task. It
  assumes Courier's hosted SDK (`@trycourier/courier`, `COURIER_API_KEY`). Its throttling guide says Courier send limits "have no API
  endpoint, so code and MCP can't set them", so an agent without a Courier account has to write its own cap. This matches the Knock situation.
- **notifkit.** README (fetched) lists quiet hours in the user's timezone, preferences, RFC 8058 one-click unsubscribe, MCP server
  `@notifkit/mcp`; no explicit frequency cap (only throttling and rate limit). Repo has `tests/idempotency.test.ts`,
  `tests/race-conditions.test.ts`. I did not read those tests.
- **aaron preference-frequency-manager.** SKILL.md is about 93 lines, no code blocks. It builds an "opt-down ladder"
  (weekly, monthly, pause, sunset) before unsubscribe; one topic mute must not suppress other topics (matches Z1 criterion 5 and
  Z3 criterion 1 in spirit). It defers send caps and quiet hours to another skill and never mentions idempotency or atomic counters.

## Recommended new arms (round 4)

**Arm C1 (recommended): Courier skills, skill-only.**
- Pin: `18c7bcbeee6d5deb58a0d9dfec9ded4f960b2132` (trycourier/courier-skills, 2026-10-22). Re-check that this SHA is still reachable before the run.
- Install as a skill-only arm, no global config:
  1. `git init courier-pin && cd courier-pin && git remote add origin https://github.com/trycourier/courier-skills && git fetch --depth 1 origin 18c7bcbeee6d5deb58a0d9dfec9ded4f960b2132 && git checkout FETCH_HEAD`
  2. Copy the folder `skills/courier` (SKILL.md + `references/`) into the arm workspace at `.claude/skills/courier/` (project-local).
  3. Do NOT use `/plugin marketplace add trycourier/courier-skills` or `npx skills add`: both write user-level config.
  4. Do not set `COURIER_API_KEY`; do not enable the Courier MCP servers. The arm is "guidance text only", same as the Knock arm.
- Add a "Courier named in prompt" variant only if the Knock-named variant is kept, to keep the arm design symmetric.
- Caveat to state in the report: the skill steers the agent to Courier's hosted API; without an account the agent must still write its
  own gate. This is the same condition the Knock arm had, so the comparison is fair, but neither arm measures the vendor's product.

**Arm C2 (optional, cheap control): aaron `preference-frequency-manager`, single skill.**
- Pin: `79c145da991dd00dad3c0b94b23a18ef27482456` (2026-10-22). Copy only `email/nurture/preference-frequency-manager/SKILL.md` to `.claude/skills/`.
- Expected result: near baseline (no code, marketing-email scope). Its value is as a "text-only, generic" control, not as a strong competitor.
  Skip it if the budget is tight. License Apache-2.0 needs the NOTICE/LICENSE kept if the folder is redistributed in a results pack.

Not recommended as arms: notifkit and notifyd (need a database, run a service; the Z tasks ask for a function in a file, so the
arm would measure infrastructure setup, not gate design). They are still worth reading for techniques.

Already covered: Knock skills (arms "knock skills" and "knock named in prompt", commit cc99682..., round 3).

### Which competitors define the scope of a "first/best" claim

A claim can only be about the arms actually run, on tasks Z1-Z6, with the model run (Sonnet; Haiku only where run):
plain Claude baseline, Knock skills, and, if added, Courier skills (and the aaron skill). It must not say "best notification
gate" in general: notifkit, notifyd, Novu, SuprSend, OneSignal, MagicBell and the hosted vendors were not run, and
the Z checkers test function behaviour in a sandbox, not a deployed service. Round-3 numbers (ours 22.33/36, knock 25.67,
baseline 24.00) do not support "best" for proactive-gate at all; they show ours below both. A true "first" claim would need a
search that I only did partially (no direct npm/PyPI/Hugging Face queries), so I would not write "first" without saying so.

## Techniques

Priority: P0 = fixes a known round-3 loss; P1 = likely gains points or cost; P2 = later or uncertain.
"Source" is where the idea is seen; "Ours" says whether proactive-gate already has it.

| Pri | Technique | Expected effect | Source / URL / license | Ours today |
|-----|-----------|-----------------|------------------------|------------|
| P0 | Resolve `STATE_DIR` (and every env/config value) at call time, not import time; keep one store per directory in a Map | Z4 (checker sets env after import); also Z1, Z2 cross-process cases | Own `scaffold.ts` lines 19-29 (already lazy in the working tree). Courier SKILL.md "Verifying against live sources": read ground truth at use time. https://github.com/trycourier/courier-skills (MIT) | Fixed in tree, uncommitted status unknown. Needs a regression test that sets `STATE_DIR` after `import` |
| P0 | Default to a durable shared store when no `STATE_DIR` is given (e.g. a directory under the project), and say so in the scaffold, so opt-out is visible to a second process | Z1 crit 2/4, Z2 crit 3/5 | Own `scaffold.ts`: `optOut` uses `store.set`, which is process-local when the store is `MemoryStore` (comment at line ~180 says "Durable with SqliteStore only"). Design echo: notifyd keeps all state in PostgreSQL, no memory path. https://github.com/rmzlb/notifyd (MIT) | Missing: memory store is the default |
| P0 | Take cap, quiet hours and consent windows from the call arguments (`config.dailyNudgeCap`, user quiet hours) instead of freezing them in `proactive-gate.policy.json` at scaffold time | Z4 crit 4 (cap 2 and 3 via config), Z6 crit 4 | Own `toInput()` reads no `config` argument (read in scaffold.ts lines 43-84); `dryRun` already overrides the cap by rebuilding a gate (lines ~164-176). Hypothesis, see Z4 below | Partial: only `dryRun` does it |
| P0 | Release the budget unit when the PUSH fails even if the in-app item was stored (spend only on a confirmed send for that surface) | Z3 crit 3 | Own scaffold.ts `deliver()`: release happens only `if (!push && !inApp)`. Z.md [ENG 7]. Hypothesis, needs the Z3 checker log | Likely wrong for push-false/inApp-true |
| P0 | Do not ship a default quiet window that contradicts the legal window the task names; if the app gives no window, ask or use the stricter 08:00-21:00 local for SMS | Z2 crit 1 | Own `DEFAULT_QUIET = 22:00-08:00` (scaffold.ts line 34) lets 21:00-21:59 through; Z2 crit 1 requires a stop at 21:00. TCPA 47 CFR 64.1200(c)(1). https://www.ecfr.gov/current/title-47/part-64/section-64.1200 | Mismatch for SMS |
| P1 | Skill text that routes: "read 1-2 files per task, don't read the tree", short entry file, depth in `references/` | Cost (round-3 path cost 1.9x baseline) | Courier SKILL.md lines 17-24; Courier AGENTS.md: SKILL.md stays near 5,000 tokens, ~500 lines. https://github.com/trycourier/courier-skills (MIT) | Ours is 37 lines, but the path forces `node -v`, `npx scaffold`, 3 files, a test run: the steps cost more than hand-writing for small tasks |
| P1 | Offer a no-install path: a short checklist the agent can apply inside code it writes itself (inline) when the task asks for one function in a file | Cost, all Z | Knock arm was text-only and scored higher with less machinery: https://github.com/knocklabs/skills (MIT) | Missing: skill is scaffold-first only |
| P1 | Put the hard requirements the Z checkers share in one checklist the agent reads: opt-out is stored durably and read on every decision; cap is a counter incremented on confirmed send, keyed by local day; redelivery key stored before send; closed reason-code list | Z1-Z4 | Knock `notification-system-implementation.md` has "Honor opt-out immediately", "Test concurrent notifications", preference hierarchy Global > Category > Channel > Quiet hours > Frequency caps. https://github.com/knocklabs/skills (MIT) | In `references/checks.md`, not in the SKILL.md the agent reads first |
| P1 | Idempotency key is the request/message id from the caller's system, not a timestamp; retries reuse it, new requests get a new one | Z2 crit 5, Z1 crit 4 | Courier `references/guides/reliability.md` ("use a request id... deterministic on retry"). https://github.com/trycourier/courier-skills (MIT) | Have `dedupeKey`; note says "explicitId" only, random UUID otherwise (scaffold line 41), so a redelivery without id is not deduped |
| P1 | Atomic counter with TTL in one step (Redis script; SQLite/Postgres `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`) | Z1 crit 4 (2 processes x 12 calls), Z2 crit 5 | Own `src/stores.ts`: `REDIS_INCR_SCRIPT`, `SqliteStore.incrBy`, `PostgresStore.incrBy`; WAL + `busy_timeout` 30000 | Have it. The hand-written arms must copy this; offer a 15-line standalone snippet |
| P1 | Throttle skips the excess (nothing waits); batching/digest combines; keep both as separate concepts, and a user-facing cadence is a digest choice | Z2, Z3 design | Courier `throttling.md` "Throttling vs Batching"; Knock `volume-and-batching.md` (collision case: five workflows eligible in ten minutes). MIT both | Have caps; digest policy not in scaffold |
| P1 | Hold vs skip: a promotional message over the cap is skipped; a utility message in quiet hours is deferred to window end and reports `availableAt` | Z6 crit 2, Z3 crit 6 | Search summary of vendor docs (Braze quiet hours: https://www.braze.com/docs/user_guide/messaging/messaging_fundamentals/quiet_hours ; Bird: https://bird.com/manual/developer/sms-api/set-up-quiet-hours). Proprietary docs, use as reference only | Have `availableAt`, `resumeAt` |
| P1 | Test the overnight window as one block (22:00-08:00 spans midnight) and DST edges | Z2 crit 1 | Adobe Journey Optimizer community thread on a 27-hour quiet-hours delay (via search summary): https://experienceleaguecommunities.adobe.com/adobe-journey-optimizer-15/unexpected-27-hour-delay-in-quiet-hours-queue-behavior-10pm-8am-249572 | Z2 tests the edges; add the same cases to `notify.test.mjs` |
| P2 | Per-topic suppression scope: muting one topic must not silence another | Z1 crit 5, Z3 crit 1 | aaron `preference-frequency-manager/SKILL.md` ("muting a topic must suppress only that stream"). Apache-2.0 | Have `mutedTypes`; check dismissal fatigue is per type |
| P2 | Suppress when the preference lookup fails (fail closed for push, keep in-app) | Z3 crit 4 | libredesk PR #444 dispatcher (via search summary): https://github.com/abhinavxd/libredesk/pull/444 | Have (`consentUnknown`) |
| P2 | Read notifkit `tests/idempotency.test.ts` and `tests/race-conditions.test.ts`, and notifyd `migrations/014_idempotency_partial_unique.sql` and `docs/articles/postgres-queue-what-skip-locked-does-not-give-you.md` for race cases to add to our tests | Z2 crit 5 flakiness | https://github.com/devkitshq/notifkit , https://github.com/rmzlb/notifyd (MIT). Files exist; I have NOT read them | Not applicable until read |
| P2 | Three outcomes (act now, wait, stay silent) as the decision shape, with silence as a normal result | Z5 | Navan blog (via search, not fetched): https://navan.com/blog/build-proactive-ai-agents ; PRISM https://arxiv.org/pdf/2602.01532 | Have `send/reason/surfaces`; no `wait` outcome except `availableAt` |

Skill-text length facts (measured from files read): Knock `knock-notification-best-practices/SKILL.md` is 109 lines and is a router to six
rule files, with no code. Courier SKILL.md is 248 lines, router table at lines 196-242. Ours is 37 lines. Short length alone did
not make ours cheaper, because the cost is in the steps the text commands, not in its size.

## Knock vs ours per task

What Knock's arm actually contains (read from the pinned clone): markdown guidance only. No gate code, no state path, no
config. The relevant rules are in `knock-notification-best-practices/rules/notification-system-implementation.md` (preference hierarchy,
frequency caps, retry, TCPA/GDPR/CAN-SPAM checklists, "Test concurrent notifications") and in
`knock-product-messaging-strategy/rules/` (`volume-and-batching.md`, `relevance-and-preferences.md`, `delivery-strategy.md`).
Its `SKILL.md` for the knock-setup skill leads to the Knock CLI and workspace, which the no-account arm cannot use.
So in the Knock arm the model writes its own implementation from its own knowledge plus a checklist. Round 3 gave Knock +1.67 over
baseline and ours -1.67 below baseline.

Ours: the model is told to run `npx proactive-gate scaffold nudge`, edit `toInput()`, and run the generated tests. The code that
decides is the scaffold's, so its defaults replace the model's own reasoning on any rule the task states but the scaffold
defaults differently. That is the main hypothesis below.

| Task | Where Knock is ahead (hypothesis) | Where ours is ahead or equal | Evidence level |
|------|-----------------------------------|------------------------------|----------------|
| Z1 check-in nudge | Not a Z2/Z3/Z4 win for Knock by your numbers. Our known loss: opt-out not shared across processes (`optOut` writes to the store; shared only when the store is `SqliteStore`, i.e. when `STATE_DIR` is set; otherwise process memory). A hand-written arm that writes a JSON/SQLite file by default shares it | Atomic daily counter and idempotency exist in `stores.ts` (2 processes x 12 calls is the case they were built for) | Task text + scaffold.ts; log not read |
| Z2 weekly digest text | Scaffold `DEFAULT_QUIET = 22:00-08:00` (line 34) is a different window than the required 08:00-21:00 (Z.md Z2.1, edges 08:00 and 20:59/21:00). Our arm gets 21:00-21:59 wrong unless the model overrides the default. A hand-written arm applies the TCPA window the model already knows. Second candidate: restart and 10-process cases (Z2.3, Z2.5) need `STATE_DIR` set before the process starts; if the checker sets it late, the pre-fix scaffold used a MemoryStore | `handleInbound` with STOP/START per channel and `gate.inbound` exist; keyword list per TCPA | Strong for the window (two lines compared). Weak for the state part |
| Z3 morning briefing push | `deliver()` releases the unit only `if (!push && !inApp)`. Z3.3 requires `push` resolving false twice to leave the allowance unspent, but the in-app item is stored, so `inApp` is true and the unit is not given back; the third attempt is then refused. A plain implementation that counts only confirmed pushes passes. Also consent-store throw, permission and category are handled in scaffold, so those probably pass | Consent throw, category, permission ("push was not used: ... permission") are handled explicitly in `toInput`/`withStoredConsent` | Medium (read from code; checker log needed) |
| Z4 ready notices and suggestions | (1) `STATE_DIR` at import time: confirmed round-3 cause, already changed in the tree. (2) `config.dailyNudgeCap` (Z4.4, tested with 2 and 3): the gate is built once at import with `dailyLimit` from the JSON policy and `toInput()` has no `config` input, so the cap cannot follow a per-call config number. A hand-written arm reads the number from `config`. (3) Z4.5 reminders: scaffold maps `origin: "reminder"` to `kind: "commitment"`, which is right if the preset exempts commitments | `REASON_CODES` exported and checked in tests; new-account hold via `createdAt`; requested notices pass the trust ramp | (1) confirmed by you; (2) medium (code read, `config` absent in `toInput`); (3) not verified |
| Z5 stay quiet | Not a Knock win in your list; no analysis | `evidence`, `hourStats`, crisis, `dedupeKey` per local day are in `toInput` | n/a |
| Z6 support and dry run | Not a Knock win in your list. Noted risk: `dryRun` uses `MemoryStore` and rebuilds the gate per call; fine for counts, and `whyNotReceived` reads a JSONL log shared by processes only when `STATE_DIR` is set | `whyNotReceived`, `dryRun`, `availableAt` exist | n/a |

Why Knock beats ours on Z2, Z3, Z4, in one sentence each (all hypotheses until the checker output is read):
- Z2: a scaffold default window (22:00-08:00) overrides the 08:00-21:00 rule that a model writing its own code would apply.
- Z3: the scaffold gives the budget unit back only when both surfaces fail, but Z3 requires giving it back when the push fails and the in-app item is stored.
- Z4: the scaffold read `STATE_DIR` at import (confirmed), and it fixes the cap in a policy file at scaffold time, while the task passes the cap in `config` per call.

Cost (cause 3, 1.9x baseline): not measured by me. Our path runs `node -v`, `npx` scaffold (network), edits three files and runs
tests; the Knock arm only reads markdown. Courier's "route first, read 1-2 files" is the closest example of cheap text I found.

## Concrete next steps (ordered)

1. Read the Z2, Z3, Z4 checker output for the ours-arm runs; confirm or reject the three hypotheses above (30 minutes, no model cost).
2. Fix and test: call-time config for caps (P0), release-on-push-failure (P0), default window rule for SMS or an explicit prompt to the agent (P0), durable default state (P0). Add a test that sets `STATE_DIR` after import.
3. Add the Courier arm (C1) with the pin above. Keep the same prompts and checkers; do not edit the Z tasks after seeing the new arm's results.
4. Decide if the skill gets an inline mode (checklist, no scaffold) for single-function tasks, then rerun only Z1-Z4 with ours.

## Sources

URLs I fetched in this session (content read or API response received):
1. https://github.com/knocklabs/skills (top-level tree; local clone read in full for the files cited) and https://api.github.com/repos/knocklabs/skills/commits?per_page=1 (cc99682..., 2026-09-30T16:04:05Z).
2. https://github.com/trycourier/courier-skills (page + local clone) and https://api.github.com/repos/trycourier/courier-skills/commits?per_page=1 (18c7bcb..., 2026-10-22T03:03:11Z).
3. https://github.com/aaron-he-zhu/aaron-marketing-skills and its `email/nurture/preference-frequency-manager/SKILL.md`; commits API (79c145d..., 2026-10-22T11:00:31Z).
4. https://github.com/devkitshq/notifkit (page + clone) and commits API (5f10994..., 2026-10-19T19:12:23Z).
5. https://github.com/rmzlb/notifyd (page + clone) and commits API (1767a73..., 2026-10-21T18:47:48Z).
6. https://www.skillsdirectory.com/skills/modbender-notify (rules summarised; license not shown).
7. https://api.github.com/repos/OneSignal/onesignal-agent-plugin/commits?per_page=1 (8133b27..., 2026-10-15T17:52:44Z). The repo page itself I did not fetch; its description is from search.

URLs seen only in search results (NOT fetched; treat claims as unverified):
- https://claudemarketplaces.com/plugins/vaaraio-vaara/vaara-governance (Vaara: runtime tool-call governance/security for Claude Code; unrelated to notifications; not installed).
- https://github.com/OneSignal/onesignal-agent-plugin ; https://skills.sh/garrytan/gbrain/cron-scheduler ; https://github.com/abhinavxd/libredesk/pull/444
- https://www.braze.com/docs/user_guide/messaging/messaging_fundamentals/quiet_hours ; https://bird.com/manual/developer/sms-api/set-up-quiet-hours
- https://experienceleaguecommunities.adobe.com/adobe-journey-optimizer-15/unexpected-27-hour-delay-in-quiet-hours-queue-behavior-10pm-8am-249572
- arXiv 2606.04296 (intervention timing for coding agents), 2602.01532 (PRISM), 2502.18658 (Codellaborator), 2605.06717 (proactivity position paper): https://arxiv.org/pdf/2602.01532 and https://arxiv.org/pdf/2605.06717 . These are about coding-agent interruptions, not user notifications; none is a runnable competitor.
- https://navan.com/blog/build-proactive-ai-agents (three-outcome framing).
- https://www.ecfr.gov/current/title-47/part-64/section-64.1200 (cited from `tasks/Z.md`, not re-fetched by me).

Local files read: `/Users/efe/Desktop/Open-Source/projelerim/proactive-gate/{bench/head-to-head/tasks/Z.md, skills/proactive-gate/SKILL.md, src/stores.ts, src/scaffold.ts}`; clone files listed in the notes above.
