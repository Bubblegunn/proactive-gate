# Head to head: proactive-gate against Claude with no plugin and Knock skills

This page is the public protocol and the results. The tasks below were frozen on 2026-10-21 before any
code of round 1 was written; the commit that adds this page is the proof (it precedes every other commit
on branch `plugin-leadership`). The harness is in `bench/head-to-head/`, so anyone can re-run it.

## Round 0 (2026-10-21), what it showed

Four tasks, five executable criteria each, one run per arm, model Sonnet. Every arm that finished
scored 20 of 20, including Claude with no plugin. The README claim that hand-written quiet hours and
daily caps get daylight-saving time and races wrong was not reproduced by those four tasks, so it is
not made. Our plugin lost in the default environment: Node 20 made npm install 0.7.3 silently, the skill
never said a candidate id must be unique per message, and the agent dropped the library for the STOP
keyword task because the library had no inbound store. Round 1 fixes those and uses harder tasks.

## The six tasks (frozen)

No prompt names a tool. Each task asks for a `bot.mjs` with a stated export, written in a fresh folder that
holds only a `package.json`. Prompts are in `bench/head-to-head/prompts/h1.txt` to `h6.txt`. Each task
combines at least three constraints. Criteria are executed code in `bench/head-to-head/checkers/`, and each
checker was validated before any run: it passes a correct reference and fails two deliberately broken
ones (`bench/head-to-head/ref/`).

### H1 Legal window, quiet hours and time zones in one decision (stateless)
`decide({ user, message, now })` returns `{ send, holdUntil, reason }`.
1. US SMS inside the legal window and outside quiet hours is sent; outside it is held (EDT dates, so a fixed offset fails).
2. A critical SMS ignores quiet hours but not the legal window; held to exactly 08:00 local on spring-forward and fall-back dates, including the repeated 01:30 hour.
3. `holdUntil` is the later of quiet-hours end and legal opening, in both orders; the reason names both rules when both hold.
4. The legal window applies to SMS to US only; critical email, push and SMS to other countries are not held; normal email is held only by quiet hours.
5. Half-hour and 45-minute zones (Kolkata, Kathmandu) have exact edges.
6. Missing or invalid time zone: nothing is sent, `holdUntil` is null, the reason contains "time zone".

### H2 Daily, weekly and monthly caps across channels, with the exact retry time
`trySend({ user, message, now })` returns `{ sent, holdUntil, reason }`; state on disk, several processes.
1. Three per local day across SMS and email together; the fourth is refused with "daily cap" and `holdUntil` at the next local midnight.
2. Seven per local ISO week (Monday 00:00): refused with "weekly cap" and `holdUntil` at the next Monday 00:00 local.
3. Daily and weekly both full: the reason names both and `holdUntil` is the later reset.
4. Twelve per local month: refused with "monthly cap" and `holdUntil` at the first of the next month, 00:00 local.
5. Daylight saving: 23-hour and 25-hour days, and a Monday reset after a spring-forward Sunday, give exact `holdUntil` values.
6. Two processes with 12 concurrent calls per user, five users, three repeats: exactly 3 sent per user; refused calls record nothing.

### H3 STOP keywords per channel, restart, snooze
`handleInbound`, `snooze`, `trySend`; state on disk, several processes.
1. Eight spellings of the stop keywords (case, spaces, trailing punctuation) revoke the channel even when the profile still says consent.
2. A stop on one channel leaves the other channels sending.
3. Only whole-message keywords revoke ("please stop by tomorrow", "thanks", "HELP", "stopping" do not).
4. START, UNSTOP and YES re-enable that channel only; a second stop blocks again; "yes please" does nothing.
5. Revocations written by one process are seen by another and survive a restart.
6. Snooze blocks every channel until the instant (exclusive), lapses by itself, does not touch other users; `consent: false` blocks; reasons contain "stop", "snooze" or "consent".

### H4 50 workers, redelivery, a crash in the middle of send
`deliver({ user, eventId, now, send })` with a cap of 5 per local day.
1. 50 worker processes at once, four users, 150 attempts per user: exactly 5 `send` calls per user.
2. The same event delivered by 10 processes at once: exactly one `send`.
3. The same event again after a restart and two days later: no second `send`.
4. A worker killed inside `send`: after restart the redelivery does not call `send` again.
5. The interrupted event still counts: six more distinct events produce exactly four sends and a refusal with "daily cap".
6. The day resets at local midnight (Istanbul), not at UTC midnight, with the reasons "daily cap" and "already delivered".

### H5 Replay a week under a changed policy
`replay({ events, policy })` and `compare({ events, policyA, policyB })`, pure computation.
1. Counts under policy A equal the reference for a 70-event week across five zones including a daylight-saving Sunday.
2. Every decision (outcome, `holdUntil`) matches, with the input shuffled and left unmodified.
3. A second policy (different quiet hours and cap) and a policy with no rules both match.
4. Reasons contain "quiet hours" or "daily cap" exactly where the outcome says so, and are null for sent events.
5. `compare` returns exactly the events whose outcome changed, in processing order, with both count objects.
6. Critical events ignore quiet hours but not the cap; events with equal timestamps keep input order.

### H6 Legal rules of four jurisdictions with official sources
`check({ user, message, now })` returns `{ allowed, reason, sources }`.
1. US SMS window 08:00 to 21:00 local with exact edges on both daylight-saving dates; US email is not limited.
2. South Korea: advertising consent, and the night consent for SMS from 21:00 to 08:00 local, email exempt.
3. India: promotional consent and the four default-off time bands, with exact edges in a +05:30 zone.
4. Germany and France: marketing consent, with the existing-customer exception.
5. Every refusal and every checked allowed message lists sources; every URL is https on an official host (list in `checkers/h6.mjs`); other countries are allowed with no sources.
6. A missing or invalid time zone refuses only where a local-time rule applies, with "time zone" in the reason.

## Extra tasks taken from the competitors' own READMEs (frozen on 2026-10-21, before any run)

Knock's skills list notification system implementation (timing, preferences, error handling) under
`knock-notification-best-practices`; Vaara's README describes governing an agent's outbound actions with a
hash-chained audit trail (Vaara itself is not run, see Rulings). Each task below is the part of those READMEs that
overlaps with what proactive-gate does. Prompts are `bench/head-to-head/prompts/x1.txt` and `x2.txt`.

### X1 Notification system: preferences, quiet hours, a cap and channel fallback
`notify({ user, notification, now, deliver })`, state on disk, several processes.
1. Channels the user switched off are skipped in order; all off gives "opted out".
2. Quiet hours 22:00 to 08:00 local with exact edges including daylight saving; security ignores them.
3. Three per local day (Istanbul midnight); security is neither counted nor stopped.
4. A throwing channel falls through to the next; all throwing gives "failed"; failures consume nothing.
5. Two processes with 12 concurrent calls per user: exactly 3 delivered per user.
6. State survives a restart; reasons contain "quiet hours" and "daily cap".

### X2 Governed outbound tool with a tamper-evident audit trail
`guardedSend({ agentId, user, message, now, send })` and `verifyAudit()`.
1. Opt-out, quiet hours 21:00 to 08:00 local with daylight-saving edges, and 5 per local day all block with the named words.
2. Every call appends one record with the exact keys in the exact order; allowed records have a null reason.
3. The hash chain matches an independent recomputation (SHA-256 of prevHash plus the record without its hash).
4. `verifyAudit` accepts an intact file and names the first broken record after an edit, a deleted line or a swap.
5. Two processes writing at once keep seq gapless and the chain intact.
6. Blocked calls never call `send`; a new process continues the chain at seq n+1 with the right prevHash.

## Arms

Each competitor runs twice. In the plain arm the prompt does not name any tool, like ours. In the invoked arm
(`knock-inv`) the prompt starts with a sentence that names the competitor's skill or plugin the way
its README does, so each competitor is also measured at its best. Our arm keeps the plain prompt. Knock's MCP
server and hosted features need a Knock account and are not run. Vaara is not run at all (see Rulings).

## Arms, runs, scoring

Arms: our plugin (this repository as a plugin directory, with the build under test packed with `npm pack` and
installed in the fixture), Claude with no plugin (the main opponent), Knock skills in a plain and an invoked arm. Vaara: not run (see Rulings). Model
`claude-sonnet-5-5`. Three runs per task and
arm, each in a fresh copy of the fixture. Every arm gets the same Node 22 or newer first on `PATH`.
Score: criteria passed per task out of 6, the mean over three runs. Cost is the `total_cost_usd` of each run.

Win rule, fixed in advance: on every task our mean is strictly above every other arm's mean, and our total is at
least 20 percent above the best other arm's total. A task on which every arm scores full marks does not
discriminate; it is reported as such.

Limits: the same side wrote the tasks and the checkers; each prompt states its rules in full, which helps the arm
with no plugin; three runs measure variance only roughly.

The tasks differ in how far they reach beyond our domain. X1 leans towards quiet hours and caps, which is what
proactive-gate does. X2 is mostly about an audit chain, which proactive-gate does not provide, so X2 is expected to
be a tie or a loss for us, and it is run for that reason. Competitor tools that need an account (Knock's MCP server
and hosted workflows) were not run.

## How to re-run

```
bash bench/head-to-head/rerun.sh --model claude-sonnet-5-5 --reps 3
```

It needs Node 22 or newer first on `PATH`, plus npm, git and a logged-in `claude` CLI. In
order, it does three things. It builds this checkout and packs it with `npm pack`, under a version that marks it as
the build under test, so the skill's version check sees the new API. It clones Knock's skills at commit
`cc99682ed74ee34198602c7d28569bd1c5f309d3`. Then it runs every arm and every task, and scores them. Every arm gets the same Node 22 or
newer folder first on `PATH`. Outputs go under `bench/head-to-head/results/`, in one folder per date and model;
`--out DIR` chooses another folder, and `--tasks` and `--arms` run a subset.

## Fairness rules we apply

- Each criterion is labelled "outcome" (what the finished code returns or stores) or "process" (how the agent got
  there) by an auditor who had not read the library, the skill or the references. The labels and the auditor's
  brief are in `bench/head-to-head/LABELS.md` and `bench/head-to-head/labels.json`. The scorer prints an
  outcome-only table next to the full table.
- Each competitor runs in two arms. The plain arm's prompt names no tool, as ours does. The invoked arm's prompt
  names the competitor's skill or plugin the way its README does, so the competitor is also measured at its best.
- Competitors are set up as their own README says, at a pinned commit.
- Everything is in the repository: prompts, checkers, reference solutions, labels, transcripts and the one-command
  re-run. A reader can run it again, or change a checker and see what changes.
- Each task's score is shown per run, with the mean, the min to max range and n. A mean alone is not shown.
- Claims are scoped to the tasks and arms listed here, and to the model that was run. The model is a parameter
  (`--model`), and a result for one model does not carry over to another.

## Results, round 1

Date 2026-10-21. Build under test: repository commit `74d4b36` (branch `plugin-leadership`), packed as
`0.10.0-h2h.0`. The first 16 runs were made at commit `e7b11b3`; `src/` and `skills/` are identical between
`e7b11b3` and `74d4b36`. Model `claude-sonnet-5-5`. Arms: ours, Claude with no plugin (baseline), Knock skills (`knock`) and
Knock skills named in the prompt (`knock-inv`). Vaara: not run (see Rulings). 8 tasks (h1 to h6, x1, x2), 3 runs
per task and arm, n = 24 runs per arm, 96 runs in all. Every transcript, produced `bot.mjs`, per-criterion result
and cost is in `bench/head-to-head/results/2026-10-21-sonnet/` (`runs/`, `work/`, `results.json`). All 48 criteria
are labelled "outcome", so the outcome-only table and the full table are the same. Command:
`bash bench/head-to-head/rerun.sh --model claude-sonnet-5-5 --reps 3 --arms ours,baseline,knock,knock-inv`.

Each cell: mean [score of each run] (min-max, n runs).

| task (max) | baseline | knock | knock-inv | ours |
|---|---|---|---|---|
| h1 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| h2 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| h3 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| h4 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| h5 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| h6 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| x1 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 5.67 [6, 6, 5] (5-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| x2 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| total of means (48) | 48.00 | 47.67 | 48.00 | 48.00 |

| measure | baseline | knock | knock-inv | ours |
|---|---|---|---|---|
| mean cost USD per run | 0.655 | 0.542 | 0.663 | 0.715 |
| runs whose bot.mjs mentions proactive-gate | 0/24 | 0/24 | 0/24 | 0/24 |
| Skill tool calls (sum) | 0 | 0 | 24 | 0 |

Per-run scores are in the brackets; the two tables are identical because no criterion is labelled "process".

### Gate

The gate is not passed. The rule requires our mean to be strictly above every other arm's mean on every task, and our
total at least 20 percent above the best other arm's total. Our mean equals the baseline mean on all 8 tasks (6.00 of
6, 48.00 of 48 in total). On these 8 tasks, this model and this date, no arm lost anything that matters: the tasks
do not discriminate between the arms. The only dropped point is one Knock run on x1 (a worker process returned no
result array); it is not evidence about Knock.

What the transcripts show:
- Our plugin was never used. In 24 runs the skill was called 0 times and no `bot.mjs` mentions proactive-gate.
  The agent read an explicit "write bot.mjs" task and wrote it by hand, like the baseline, correctly, including
  daylight-saving time, the 50-process cap and the crash-in-send case. The library gave no measurable benefit here.
- Cost: our arm was the most expensive (0.715 USD per run on average against 0.655 for the baseline and 0.542 for
  Knock without invocation). It paid for loading the plugin and gained nothing from it.
- The README claim that hand-written quiet hours and caps get daylight-saving time or races wrong is still not
  reproduced, now on 8 tasks and 96 hand-written solutions.

### What round 2 would change

1. Make the skill fire. Zero of 24 runs invoked it, so no skill text matters until it does. Test the description on
   the words these prompts use ("bot", "reminder", "text users", "cap", "worker processes") with the
   `claude plugin` skill-trigger check, and consider a hook-free alternative such as a short name-and-purpose line
   that the model sees in its skill list. Measure the invocation rate before any scoring run.
2. Find tasks the no-plugin model fails. At 6 of 6 on 8 tasks the benchmark cannot show a win. Candidates left:
   a task where the code must interoperate with an existing store or policy file in the fixture (the library's JSON
   policy and replay tooling become the shortest path), tasks with an existing codebase to modify, or tasks that ask
   for the explanation a person reads (the `explain` output) instead of the number. A task must be validated with
   the baseline before it is frozen, and the replacement logged, as the ruling in the spec requires.
3. Run Haiku and Opus on the same tasks. A weaker model may hand-write less reliably, which is where a library
   helps; that is a measurement, not an expectation.

## Round 2 (frozen 2026-10-21, before any round-2 code change)

### Rulings that set up round 2

- All 8 round-1 tasks were saturated (every arm at the ceiling), so under the spec ruling they are replaced. The
  replacements were chosen from what a product team needs that the library provides and hand-written code has to
  reinvent. They were not chosen by looking at where the baseline fails, and they are validated only for checker
  correctness (the correct reference passes, the broken references fail).
- Efficiency counts as an outcome the user feels. Every run records cost in USD, wall time, turns and lines of code
  the agent wrote (non-blank lines in the files it produced, not counting package files and `node_modules`). They are
  reported per arm next to the scores. Target: the library path is cheaper than hand-writing, so our cost and lines of
  code fall below the baseline's.
- Skill firing comes first. The plugin gets a lightweight `UserPromptSubmit` hook and a sharper description. The
  invocation rate is measured on 10 natural prompts and the false-trigger rate on 20 unrelated prompts before any
  scoring run, and at least 9 of 10 are required.
- Scoring runs on Sonnet (`claude-sonnet-5-5`) and on Haiku (`claude-haiku-5-5`), 3 runs per task and arm each.
- Vaara stays out; the guard on the real configuration stays on.

### The six round-2 tasks (prompts `bench/head-to-head/prompts/y1.txt` to `y6.txt`)

- Y1 Legal contact windows of several jurisdictions with cited sources: US federal 08:00 to 21:00, the stricter state
  window of FL, OK and MD, EU and UK consent with the existing-customer exception, the Korean night rule; each
  refusal carries the time it ends and official sources.
- Y2 A reason a product manager can read for each blocked message: the rule phrase, the user's local time, and when
  the message will go, in local time with today or tomorrow; no internal values.
- Y3 Replay last week under a proposed policy: sent, held and refused counts, the number stopped by each rule, and the
  list of events whose outcome or rule changed between two policies, including a weekly cap.
- Y4 Audit why a user got nothing: every decision is recorded durably across processes; `whyNothing` lists each
  blocked message with its rule and reason over a time range and gives a one-sentence verdict.
- Y5 Switch the store from memory to SQLite by changing one configuration value: the same answers under both,
  shared and persistent state under SQLite, the cap holding across processes.
- Y6 The same policy file gives the same answers in Node, Python and Go.

Each has six executable criteria in `bench/head-to-head/checkers/y1.mjs` to `y6.mjs` (added after this commit, validated
against a correct reference and two broken ones). For Y1: both federal and state windows with exact edges on
daylight-saving dates, `holdUntil` the later of all windows, EU and UK consent, Korea night consent, official sources,
time zone handling. For Y2: the rule phrase, the local time and the allow-again time exact for several zones, today
and tomorrow, no forbidden text, precedence of the rules. For Y3: counts and decisions equal to a reference, weekly
cap, rule breakdown, `compare` output, input not modified, ties. For Y4: blocked list and rules, range edges, verdict
wording, persistence across processes, no lost record under concurrency. For Y5: identical answers across both
stores, persistence, concurrent cap, bad configuration. For Y6: each language correct, agreement on a second policy,
daylight-saving and half-hour edges, missing or invalid policy file.

## Results, round 2

Date 2026-10-21. Build under test: commit `6ed9f4c` (branch `plugin-leadership`), packed as `0.10.0-h2h.0`, with the
`UserPromptSubmit` hook, the rewritten description and `init --minimal --legal`. Tasks Y1 to Y6. Arms: ours, Claude
with no plugin (baseline), Knock skills (`knock`) and Knock skills named in the prompt (`knock-inv`); Vaara is not run
(see Rulings). Models `claude-sonnet-5-5` and `claude-haiku-5-5`, 3 runs per task and arm, n = 18 runs per arm and
model, 144 runs in all. A first scoring attempt on the same day was void: the account limit was reached and all 144
runs returned "You've hit your limit"; its folders were deleted and the runner now stops when a run fails for that
reason. All 36 criteria are labelled "outcome" (`bench/head-to-head/LABELS.md`, `labels.json`), so the outcome-only and
full tables are identical. Transcripts, produced code, per-criterion results and cost are under
`bench/head-to-head/results/2026-10-21-round2-sonnet/` and `-haiku/`.

### Skill firing, measured before any scoring run

`bench/head-to-head/trigger/` (10 natural prompts, 20 unrelated prompts including near misses, `claude -p` with the
plugin directory, 3 turns). Sonnet: the skill was invoked on 10 of 10 natural prompts and 0 of 20 unrelated. Haiku: 9 of
10 and 0 of 20. The hook alone fires on 7 of 10 natural prompts and 0 of 20 unrelated ones; the sharper description
carries the rest. The hook takes 7.6 ms on average (p95 10.4 ms). Requirement: at least 9 of 10; met on both models.

### Sonnet (`claude-sonnet-5-5`), outcome criteria

| task (max) | baseline | knock-inv | knock | ours |
|---|---|---|---|---|
| y1 (6) | 5.00 [5, 5, 5] (5-5, n=3) | 5.00 [5, 5, 5] (5-5, n=3) | 5.00 [5, 5, 5] (5-5, n=3) | 5.00 [5, 5, 5] (5-5, n=3) |
| y2 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 4.00 [6, 0, 6] (0-6, n=3) |
| y3 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| y4 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| y5 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| y6 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| total of means (36) | 35.00 | 35.00 | 35.00 | 33.00 |

| measure | baseline | knock-inv | knock | ours |
|---|---|---|---|---|
| mean cost USD per run | 0.768 | 0.668 | 0.713 | 1.026 |
| mean wall time per run, seconds | 162 | 146 | 153 | 148 |
| mean turns per run | 13.1 | 13.1 | 13.1 | 20.4 |
| mean lines of code written (source files) | 261 | 215 | 242 | 152 |
| mean lines written (all text files) | 261 | 215 | 243 | 152 |
| runs whose solution mentions proactive-gate | 0/18 | 0/18 | 0/18 | 15/18 |
| Skill tool calls (sum) | 0 | 18 | 0 | 18 |

### Haiku (`claude-haiku-5-5`), outcome criteria

| task (max) | baseline | knock-inv | knock | ours |
|---|---|---|---|---|
| y1 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 5.33 [5, 6, 5] (5-6, n=3) | 5.67 [5, 6, 6] (5-6, n=3) | 5.00 [4, 5, 6] (4-6, n=3) |
| y2 (6) | 5.33 [5, 6, 5] (5-6, n=3) | 5.00 [5, 5, 5] (5-5, n=3) | 5.00 [5, 5, 5] (5-5, n=3) | 4.67 [5, 5, 4] (4-5, n=3) |
| y3 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| y4 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| y5 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| y6 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) |
| total of means (36) | 35.33 | 34.33 | 34.67 | 33.67 |

| measure | baseline | knock-inv | knock | ours |
|---|---|---|---|---|
| mean cost USD per run | 0.303 | 0.259 | 0.302 | 0.362 |
| mean wall time per run, seconds | 92 | 155 | 89 | 107 |
| mean turns per run | 9.2 | 9.8 | 9.1 | 14.2 |
| mean lines of code written (source files) | 177 | 168 | 176 | 157 |
| mean lines written (all text files) | 178 | 168 | 176 | 157 |
| runs whose solution mentions proactive-gate | 0/18 | 0/18 | 0/18 | 8/18 |
| Skill tool calls (sum) | 0 | 13 | 0 | 18 |

### Reading the results

- The skill fired in all 18 of our runs on both models. With it, the library was used in 15 of 18 Sonnet solutions
  and 8 of 18 Haiku solutions (the others were still hand-written after the skill was loaded).
- Code written: on Sonnet our arm wrote 152 lines against 261 for the baseline (42 percent fewer), on Haiku 157
  against 177 (11 percent fewer). That target is met.
- Cost and turns: not met. Our arm cost more per run (Sonnet 1.03 against 0.77 USD, Haiku 0.36 against 0.30) and took
  more turns (20.4 against 13.1 on Sonnet, 14.2 against 9.2 on Haiku). Loading the skill and installing the package cost
  more than the lines it saved. Wall time was about the same on Sonnet and 16 percent higher on Haiku.
- Scores: no task has our mean strictly above every other arm. On Sonnet we are level on 5 tasks and behind on Y2 (one
  run scored 0 because `decide` returned a Promise where the prompt says `function`; its content was not scored;
  the checker is frozen and was not changed after seeing this). On Haiku the baseline total is 35.33 against our 33.67.
  The library did not make Haiku correct where hand-written Haiku fails: Haiku's baseline total is higher than ours.
  Our Haiku misses were a reason of more than one sentence on Y2 (3 of our runs against 2 of the baseline's), a
  `sendAt` one hour wrong on the spring-forward day in the one Y2 run that did use the library, and an `http` source
  URL on Y1 in a run that did not use it.
- Y1 criterion 3 (holdUntil for a Korean sms blocked only by the missing night consent) was read the other way in all
  12 Sonnet runs and in most Haiku runs (the three Haiku baseline runs matched the checker). The auditor flagged it as
  ambiguous before the runs; it lowers the arms that read it the other way and was not changed.
- Knock skills tie the baseline within noise, with or without being named.

### Gate

Not passed. Our mean is not strictly above every other arm on any task, and our totals are below the best other arm on
both models (33.00 against 35.00 on Sonnet, 33.67 against 35.33 on Haiku). Round 2 achieved the firing target and the
lines-of-code target and missed the cost target and the score gate. By the rule in the spec, a third improvement round is
the last allowed; this one was run once and stops here.

### What round 3 would change

1. Cut the cost of using the library: the skill is long (about 220 lines) and the agent spends turns reading it and
   installing the package. A short front page of at most 40 lines that holds the ten-line integration, with the rest on
   request, and a package that is already in the fixture's `package.json` would shorten the path.
2. Offer a synchronous decision path (`gate.evaluateSync` for memory-backed gates) so a task that asks for a plain
   `function` is not pushed towards `async`.
3. Make `explain(decision)` produce a reason with the local time and the allow-again time, since product-readable
   reasons were a stated need and the agent hand-wrote them.
4. Re-score with the Y1 criterion 3 ambiguity resolved in the prompt for all arms, in a new task version, not by editing
   this one.

## Results, round 3

Date 2026-10-22. Build under test: commit `30fdfae` (branch `plugin-leadership`), packed as `0.10.0-h2h.0`; the probe
passed. Tasks Z1 to Z6. Arms: ours, Claude with no plugin (baseline), Knock skills (`knock`) and Knock skills named in
the prompt (`knock-inv`); Vaara is not run. Models `claude-sonnet-5-5` and `claude-haiku-5-5`, 3 runs per task and arm,
n = 18 runs per arm and model, 144 runs in all, parallelism 2. All criteria are labelled "outcome", so the outcome-only
and full tables are identical. Tables: `bench/head-to-head/results/round3-sonnet/` and `round3-haiku/`. Transcripts and
produced code are not committed.

Run in a Linux cloud container. The runner's fixed `PATH` does not contain the folder of the `claude` binary there, so
`claude` was linked into `/usr/local/bin`; the harness was not changed. The headless runs inherit the cloud session's
environment, the same for every arm; turn counts are lower than in round 2 (baseline 3.7 turns on Sonnet against 13.1),
so absolute numbers are not comparable with the earlier rounds. A container restart interrupted two Sonnet runs
(`knock-z3-2`, `ours-z3-2`); their partial folders were deleted and they were run again from scratch. No run failed for
an account limit.

### Skill firing, measured before the scoring runs

`bench/head-to-head/trigger/measure.mjs` on the 35-line skill: Sonnet invoked it on 10 of 10 natural prompts and 0 of 20
unrelated ones; Haiku on 9 of 10 and 0 of 20. Requirement (at least 9 of 10) met on both models.

### Sonnet (`claude-sonnet-5-5`), outcome criteria

| task (max) | baseline | knock-inv | knock | ours |
|---|---|---|---|---|
| z1 (6) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 6.00 [6, 6, 6] (6-6, n=3) | 5.00 [5, 5, 5] (5-5, n=3) |
| z2 (6) | 4.00 [5, 3, 4] (3-5, n=3) | 4.00 [4, 4, 4] (4-4, n=3) | 4.67 [4, 4, 6] (4-6, n=3) | 4.00 [4, 4, 4] (4-4, n=3) |
| z3 (6) | 3.00 [4, 5, 0] (0-5, n=3) | 3.00 [0, 4, 5] (0-5, n=3) | 4.33 [4, 6, 3] (3-6, n=3) | 3.00 [3, 3, 3] (3-3, n=3) |
| z4 (6) | 2.00 [2, 2, 2] (2-2, n=3) | 2.00 [2, 2, 2] (2-2, n=3) | 2.67 [4, 2, 2] (2-4, n=3) | 0.00 [0, 0, 0] (0-0, n=3) |
| z5 (6) | 4.00 [4, 4, 4] (4-4, n=3) | 3.00 [3, 3, 3] (3-3, n=3) | 4.00 [4, 4, 4] (4-4, n=3) | 5.33 [5, 5, 6] (5-6, n=3) |
| z6 (6) | 5.00 [5, 5, 5] (5-5, n=3) | 5.00 [5, 5, 5] (5-5, n=3) | 4.00 [4, 4, 4] (4-4, n=3) | 5.00 [5, 5, 5] (5-5, n=3) |
| total of means (36) | 24.00 | 23.00 | 25.67 | 22.33 |

| measure | baseline | knock-inv | knock | ours |
|---|---|---|---|---|
| mean cost USD per run | 0.140 | 0.188 | 0.140 | 0.272 |
| mean wall time per run, seconds | 146 | 332 | 90 | 238 |
| mean turns per run | 3.7 | 4.8 | 3.8 | 11.8 |
| mean lines of code written (source files) | 161 | 149 | 160 | 249 |
| runs whose solution mentions proactive-gate | 0/18 | 0/18 | 0/18 | 18/18 |
| Skill tool calls (sum) | 0 | 18 | 0 | 18 |

### Haiku (`claude-haiku-5-5`), outcome criteria

| task (max) | baseline | knock-inv | knock | ours |
|---|---|---|---|---|
| z1 (6) | 5.67 [6, 6, 5] (5-6, n=3) | 4.00 [6, 0, 6] (0-6, n=3) | 5.67 [5, 6, 6] (5-6, n=3) | 4.67 [5, 5, 4] (4-5, n=3) |
| z2 (6) | 4.00 [4, 4, 4] (4-4, n=3) | 4.67 [5, 4, 5] (4-5, n=3) | 4.67 [5, 5, 4] (4-5, n=3) | 2.67 [1, 4, 3] (1-4, n=3) |
| z3 (6) | 4.00 [4, 4, 4] (4-4, n=3) | 5.00 [5, 6, 4] (4-6, n=3) | 3.67 [5, 3, 3] (3-5, n=3) | 2.00 [1, 1, 4] (1-4, n=3) |
| z4 (6) | 3.33 [4, 2, 4] (2-4, n=3) | 2.67 [2, 2, 4] (2-4, n=3) | 2.00 [2, 2, 2] (2-2, n=3) | 4.33 [4, 5, 4] (4-5, n=3) |
| z5 (6) | 4.00 [4, 4, 4] (4-4, n=3) | 4.00 [4, 4, 4] (4-4, n=3) | 4.00 [4, 4, 4] (4-4, n=3) | 4.00 [4, 4, 4] (4-4, n=3) |
| z6 (6) | 4.33 [4, 4, 5] (4-5, n=3) | 4.00 [4, 4, 4] (4-4, n=3) | 4.33 [4, 4, 5] (4-5, n=3) | 5.00 [5, 5, 5] (5-5, n=3) |
| total of means (36) | 25.33 | 24.33 | 24.33 | 22.67 |

| measure | baseline | knock-inv | knock | ours |
|---|---|---|---|---|
| mean cost USD per run | 0.020 | 0.020 | 0.019 | 0.025 |
| mean wall time per run, seconds | 104 | 96 | 98 | 108 |
| mean turns per run | 7.5 | 9.4 | 7.1 | 14.1 |
| mean lines of code written (source files) | 188 | 176 | 205 | 127 |
| runs whose solution mentions proactive-gate | 0/18 | 0/18 | 0/18 | 15/18 |
| Skill tool calls (sum) | 0 | 18 | 0 | 16 |

### Reading the results

- The tasks discriminate now: no arm is at the ceiling on most tasks, unlike rounds 1 and 2.
- Where we lead: Z5 on Sonnet (5.33 against 4.00), Z4 and Z6 on Haiku (4.33 against 3.33, 5.00 against 4.33).
- Sonnet Z4 is 0 in all three of our runs for one reason: each solution reads `STATE_DIR` at import and throws when it is
  not set. The checker imports `bot.mjs` before it sets `STATE_DIR` per case, so every case fails at load. The baseline
  solutions read it lazily. The prompt does not say when `STATE_DIR` is set; the checker is frozen and was not changed.
- Sonnet Z1: one criterion (opt-out survives a new process) failed in all three of our runs; a second process allowed
  the opted-out user.
- The library was used in 18 of 18 Sonnet and 15 of 18 Haiku solutions. It cut code on Haiku (127 lines against 188) but
  not on Sonnet (249 against 161).
- Cost: our arm costs 1.94 times the baseline on Sonnet and 1.27 times on Haiku, and takes about twice the turns.

### Gate

Not passed on either model.
- Rule B (strictly above every other arm on each task): Sonnet only Z5; Haiku only Z4 and Z6.
- Rule A (lost points at most 80 percent of the best other arm's): Sonnet 13.67 against 10.33 (knock), Haiku 13.33
  against 10.67 (baseline); fails on both.
- Ceiling rule: Sonnet Z1 (other arms at 6.00, ours 5.00) fails.
- Cost rule (mean cost per run not above the baseline's): fails on both models.

## Round 4 measurement protocol (frozen 2026-10-22, owner decision)

Written and committed before any round-4 benchmark run, and before any round-4 result is known. This section is not
edited after results are seen; later facts go into a new section.

### What stays the same and what is reused

Tasks Z1 to Z6 are unchanged since the round-3 freeze: prompt text, fixtures, checker scripts, labels, scorer
(`run.mjs`, `score.mjs`) and the Knock pin (`cc99682ed74ee34198602c7d28569bd1c5f309d3`) have no diff between commit
`30fdfae` (round-3 build) and the commit that adds this section, except the adding of the Courier arms to `run.mjs`
(arm table only; the run, the checker and the scoring code are untouched). Models are `claude-sonnet-5-5` and
`claude-haiku-5-5`, as in round 3. Source round: round 3, results commit `5f4a3f8` (tables in
`bench/head-to-head/results/round3-sonnet/` and `round3-haiku/`).

Rule for this round:

- On Z1 to Z6, the cells of `baseline`, `knock` and `knock-inv` are not run again. They are taken unchanged from round 3
  and marked "r3 reused" in the results table. Only `ours` is run again, 3 runs per task and model, and graded by the
  same checkers.
- Courier arms are new (see below), so they have no earlier score: all of their cells are run, 3 runs per task and model.
- Rule A, Rule B, the ceiling rule and the cost rule are computed exactly as in round 3, over all arms present
  (ours, baseline, knock, knock-inv, courier, courier-inv). The baseline cost per run is also taken from round 3
  (Sonnet 0.140 USD, Haiku 0.020 USD).
- The final gate (held-out tasks, Haiku and Opus runs, independent 10 percent audit) is exempt: all arms run in full.
- If a cell of a reused arm has no stored score in this repository, that task is run for all arms. (All 72 reused
  cells below exist.)

Disclosed limits of reusing cells: the round-3 cells ran in a Linux cloud container on the cloud session's plan; the
round-4 `ours` cells and all Courier cells run on macOS with the organisation's API key. Wall time and turn counts are
therefore not comparable across the two groups and are not used in any rule. The pass/fail checkers run the produced
code the same way in both. Three runs per cell measure variance only roughly.

### Reused cells (round 3, outcome criteria, per-run scores)

Sonnet (`claude-sonnet-5-5`):

| task | baseline | knock-inv | knock |
|---|---|---|---|
| z1 | 6.00 [6, 6, 6] | 6.00 [6, 6, 6] | 6.00 [6, 6, 6] |
| z2 | 4.00 [5, 3, 4] | 4.00 [4, 4, 4] | 4.67 [4, 4, 6] |
| z3 | 3.00 [4, 5, 0] | 3.00 [0, 4, 5] | 4.33 [4, 6, 3] |
| z4 | 2.00 [2, 2, 2] | 2.00 [2, 2, 2] | 2.67 [4, 2, 2] |
| z5 | 4.00 [4, 4, 4] | 3.00 [3, 3, 3] | 4.00 [4, 4, 4] |
| z6 | 5.00 [5, 5, 5] | 5.00 [5, 5, 5] | 4.00 [4, 4, 4] |

Haiku (`claude-haiku-5-5`):

| task | baseline | knock-inv | knock |
|---|---|---|---|
| z1 | 5.67 [6, 6, 5] | 4.00 [6, 0, 6] | 5.67 [5, 6, 6] |
| z2 | 4.00 [4, 4, 4] | 4.67 [5, 4, 5] | 4.67 [5, 5, 4] |
| z3 | 4.00 [4, 4, 4] | 5.00 [5, 6, 4] | 3.67 [5, 3, 3] |
| z4 | 3.33 [4, 2, 4] | 2.67 [2, 2, 4] | 2.00 [2, 2, 2] |
| z5 | 4.00 [4, 4, 4] | 4.00 [4, 4, 4] | 4.00 [4, 4, 4] |
| z6 | 4.33 [4, 4, 5] | 4.00 [4, 4, 4] | 4.33 [4, 4, 5] |

### Competitor scope (research of 2026-10-22, `docs/RESEARCH-ROUND4.md`)

Searched: GitHub, awesome lists and skill directories, npm/PyPI, Hugging Face, the Claude Code plugin ecosystem and
arXiv. The three strongest alternatives to the user problem, besides Knock skills (already an arm): Courier skills
(MIT), notifkit (MIT), aaron-marketing-skills `preference-frequency-manager` (Apache-2.0). notifyd (MIT) and the
OneSignal agent plugin were also considered.

New arms, decided here before any run:

- `courier` and `courier-inv`: trycourier/courier-skills at commit `18c7bcbeee6d5deb58a0d9dfec9ded4f960b2132`
  (MIT, plugin version 1.8.1), skill-only, the same way Knock runs: the repository is exported with `git archive` at
  that commit, only `skills/courier` is placed in a generated local plugin directory with a minimal manifest, the
  Courier docs MCP server is not started (`--strict-mcp-config`) and no `COURIER_API_KEY` is set. The invoked
  arm prepends: "Use the courier skill from the Courier skills plugin for this. ". Installation by marketplace or
  `npx skills add` is not used, because both write user-level configuration. The hash guard on the real `hooks` and
  `mcpServers` runs before and after every job, as for every other arm. The code is only read and used as text.
- Not added: notifkit and notifyd (they need PostgreSQL or Redis and a running service, so an arm would measure
  infrastructure setup, not the gate), the aaron skill (marketing-email strategy text with no code and no send caps; it
  is listed here as the third alternative and not run), OneSignal (needs a hosted account). Vaara is never run.

Scope of any "first" or "best" claim after this round: only the arms run on Z1 to Z6 with the models run. That is plain
Claude, Knock skills (plain and invoked), Courier skills (plain and invoked) and our plugin. Notifkit, notifyd, the
aaron skill, Novu, SuprSend, MagicBell, OneSignal and other hosted vendors are outside the claim. The search for
alternatives was done by web search and GitHub pages, not by direct npm, PyPI or Hugging Face registry queries, so no
claim of "the only one" is made.

### Runs, order, stop rule

1. Haiku, `ours` and both Courier arms, Z1 to Z6, 3 runs each, as a direction check. If the gate cannot pass on
   Haiku, one product iteration is allowed, and every build that was measured is reported with its commit.
2. Sonnet with the final build, the same set of arms.
3. Scoring is the unchanged `score.mjs`; every criterion is labelled "outcome". The results table marks reused cells
   "r3 reused".
4. Parallelism 2. A cell that fails for a rate limit or API error is deleted and run again, never graded.
5. Spending: the sum of `total_cost_usd` over all headless runs of this session is capped at 30 USD; no new run starts
   at 24.0 USD.

## Results, round 4 (Haiku only; Sonnet not run)

Date 2026-10-22. Model `claude-haiku-5-5`, tasks Z1 to Z6, outcome criteria (all criteria are "outcome"), protocol above.
Build 1 is commit `53700e7` (tables in `results/round4-haiku/`: ours, courier, courier-inv, 3 runs per cell). Build 2 is
commit `c47f693`, which only adds one line to the skill (tables in `results/round4-haiku-b/`: ours only). The runner got
two harness fixes before these results: a minimal environment for `claude -p` and `CLAUDE_CONFIG_DIR`, because with only a
throw-away `HOME` the first 3 runs still loaded 43 user-level skills of the machine owner; those 3 runs were deleted and
are not used. Cells marked "r3 reused" come from round 3 and were run in a Linux cloud container.

| task (max 6) | baseline (r3 reused) | knock-inv (r3 reused) | knock (r3 reused) | courier-inv | courier | ours build 1 | ours build 2 |
|---|---|---|---|---|---|---|---|
| z1 | 5.67 | 4.00 | 5.67 | 6.00 | 5.67 | 5.33 | 5.33 |
| z2 | 4.00 | 4.67 | 4.67 | 4.33 | 5.00 | 1.00 | 2.00 |
| z3 | 4.00 | 5.00 | 3.67 | 2.67 | 4.00 | 1.33 | 3.00 |
| z4 | 3.33 | 2.67 | 2.00 | 2.00 | 2.00 | 4.00 | 4.00 |
| z5 | 4.00 | 4.00 | 4.00 | 4.00 | 4.00 | 4.00 | 4.00 |
| z6 | 4.33 | 4.00 | 4.33 | 4.33 | 4.00 | 4.33 | 4.33 |
| total of means (36) | 25.33 | 24.33 | 24.33 | 23.33 | 24.67 | 20.00 | 22.67 |

Gate (final build, build 2): not passed.
- Rule B: only Z4 (4.00 against 3.33). Z1, Z2, Z3 are lost, Z5 and Z6 are ties.
- Rule A: lost points 13.33 against 10.67 for the baseline; the limit is 8.53. Fails.
- Cost rule: not decidable. Ours cost 0.374 USD per run in this environment; the reused baseline cost (0.020) was measured
  in a different environment, and the courier arm in the same environment as ours cost 0.212. The two numbers are not
  comparable and no cost claim is made.
- The Z2 and Z3 losses of build 1 came from one cause: the data of a digest or a briefing has no consent field, and the
  generated gate held every message for missing consent. Build 2 added one skill line about it; Z2 stays at 2.00 and Z3
  rises to 3.00 (one run scored 1).
- Sonnet was not run: the spending rule of the protocol (no new run at 24.0 USD, 30 USD in all) leaves no room for 18 more
  runs of ours on Sonnet after the two Haiku builds. No Sonnet claim is made.
- No "first" or "best" claim is supported. Courier skills, as run, score at or above ours on this model.

## Rulings

- 2026-10-21, Vaara is not run. It is listed as "not run: rewrites the global Claude Code config, unsafe to execute
  here". Twice, running it wrote hooks into the real `~/.claude/settings.json` even though every run had a throw-away
  `HOME`, and the second time it also left stress-test workers behind. It is also a different product, because it
  governs Claude's own tool calls, not the messages an application sends. It is never counted as a win or as a tie
  for us. Every earlier mention of a Vaara arm in this page (including the Vaara arm of task X2) is void; no Vaara
  run is part of the results, and the Vaara folders were deleted.
- Knock's MCP server and hosted workflows need an account and were not run; Knock runs as skills only, in a plain arm
  and an invoked arm.
- The model is passed as a full id (`claude-sonnet-5-5`) because the alias `sonnet` returned a 404 under a fresh
  throw-away `HOME` in the first attempt (no run from that attempt is used).
- The runner keeps a guard for the remaining competitor: it hashes the real `hooks` and `mcpServers` before and after
  every run and stops if either changed.

## Resume (state at 2026-10-22, for whoever continues round 3, for example a Linux cloud agent)

Update 2026-10-22: steps 1 to 4 below are done; see "Results, round 3". The gate is not passed on either model. By the
spec, a third improvement round is the last allowed, so whether a round 4 runs is the owner's decision. If it
does, candidates from the transcripts: the skill and `scaffold nudge` should read `STATE_DIR` lazily (at first use, not
at import), opt-out must be read from the shared store in every process, and the skill path must cost no more than
hand-writing. Tasks Z1 to Z6 would need new frozen variants, not edits. In a cloud container, link `claude` into
`/usr/local/bin` first, because the runner's `PATH` is fixed.

Round 3 is implemented and frozen; the scoring runs have not started. Work on branch `plugin-leadership`. Frozen before
code changes: tasks Z1 to Z6 (`prompts/z1.txt` to `z6.txt`, criteria and sources in `tasks/Z.md`), with relaxations
applied before any run (Amendments in `tasks/Z.md`) and labels from an independent auditor (`labels.json`,
`LABELS.md`). The last commits only reword comments and documentation; the library code the arms use is the code of the
frozen round-3 implementation.

Requirements: Node 22 or newer (set `NODE_BIN` if `node` on the path is older), npm, git, the `claude` CLI logged in
(it needs only the API credentials; the runner uses a throw-away `HOME`, so it never reads or writes your own Claude
configuration). Run `npm ci` once in the repository root. All paths below are relative to the repository root.

The win rule for this repository in round 3: on each of Z1 to Z6 our mean is strictly above every other arm's mean
(rule B); our lost points (maximum minus our total) are at most 80 percent of the best other arm's lost points, that is
20 percent fewer errors (rule A, restated); when another arm reaches the maximum on a task we pass that task only if we
also reach the maximum (ceiling rule); and our mean cost per run is not above the baseline's. Both models are scored,
Sonnet (`claude-sonnet-5-5`) and Haiku (`claude-haiku-5-5`), 3 runs per task per arm, arms ours, baseline, knock,
knock-inv. Vaara stays out: its installer rewrites the global Claude Code configuration.

Next steps, in order (the account rate limit is shared, so run one model at a time and wait for the owner's go):
1. Firing check on the 35-line skill: `node bench/head-to-head/trigger/measure.mjs --out /tmp/trigger-sonnet --model claude-sonnet-5-5`
   and again with `claude-haiku-5-5`; at least 9 of 10 natural prompts must invoke the skill.
2. `bash bench/head-to-head/rerun.sh --commit "$(git rev-parse HEAD)" --model claude-sonnet-5-5 --reps 3 --arms ours,baseline,knock,knock-inv --tasks z1,z2,z3,z4,z5,z6 --out bench/head-to-head/results/round3-sonnet`
   (builds from an immutable `git archive` of that commit, records `COMMIT`, runs the probe first, keeps a guard on the
   real hooks and MCP servers). Use `--dry-run` first to check the set-up.
3. The same with `claude-haiku-5-5` and `--out bench/head-to-head/results/round3-haiku`.
4. Write "Results, round 3" here with per-run scores, mean, min-max, n, cost, turns, wall time and lines of code per arm,
   the gate verdict under the rule above, and commit the transcripts. Runs that fail for an account limit or an API
   error are never graded; delete them and run again.

## Round 5 (frozen 2026-10-22, owner decision, before any round-5 code change and before any round-5 scoring run)

This section is written and committed before the product changes of round 5 and before any scoring run. It is not edited
after results are seen; later facts go into a new section. Evidence folder: `bench/head-to-head/results/round5-*/`.

### Diagnosis (details in `docs/ROUND5-DIAGNOSIS.md`)

Build 2 (`c47f693`) lost 2.0 points to plain Claude on Haiku (22.67 against 24.67 in a same-environment baseline run). The
losses are general classes, not task facts:

1. Wrong default for data the task does not carry. When the task data had no consent field, 4 of 18 runs treated "absent" as
   "no consent" (or invented a key such as `consents.proactive`), so the gate held every message. Three of these runs scored
   1 of 6. The skill line that was meant to prevent it ("set `requested`") is false in the library (`src/checks.ts:298`,
   `src/scaffold.ts:67`).
2. A skill path that learns a many-check library from compiled source: 12.9 tool calls before the first file write against
   1.7 for plain Claude; no run (0 of 15) used the scaffold; agents hand-assembled gates and lost the refund of a budget unit on a refused push.
3. State bound at first use: three runs read `STATE_DIR` once and then served another directory.
4. Library defects the agents copied: `inApp` taken from the return value of a transport that returns nothing
   (`src/scaffold.ts:145`); the STOP list lacks REVOKE and OPT OUT, which the TCPA text names.
5. Not supported by the evidence: too much code (ours wrote fewer lines), wrong window defaults.

### Decisions (frozen here)

- (a) Missing data. Rule written into the skill: use only the fields the task gives and never invent a field or key; a missing field
  is "unknown", not "no". A message the user signed up for or asked for (a digest, a briefing, a reminder) is requested: allowed
  without a consent field. Marketing or promotion needs an explicit opt-in. Unknown and not requested: hold, give the reason, and
  say the assumption in the final answer in one sentence. The scaffold's `toInput` follows the same rule: a requested candidate
  with no consent information at all counts as consented.
- (b) Inline mode. `skills/proactive-gate/SKILL.md` becomes a short checklist for writing the gate in one file with no install and
  no scaffold, with at most about 6 turns (one write, one self-check). The library, the scaffold and the references stay for
  projects that already depend on the library or ask for it. The `description` line of the skill is unchanged, so the firing
  check of round 3 (at least 9 of 10 natural prompts) still describes the same trigger text.
- (c) Library fixes: read `STATE_DIR` per directory (a store cached by its directory); `inApp` true when the transport call
  resolves unless it returns `false`; STOP keywords include REVOKE and OPT OUT (TCPA text in `tasks/Z.md`).
- Competitor methods read (read only, pinned `18c7bcb` Courier and `cc99682` Knock, `docs/ROUND5-DIAGNOSIS.md` section 4):
  both are API-product skills; their relevant general statements are "a topic default applies until the user changes it"
  (Courier `references/guides/preferences.md:9`, `:68-69`) and "defaults should match role and product use" (Knock
  `rules/relevance-and-preferences.md:80`). That is the basis of the rule in (a). Neither gives a rule for a missing consent
  field, a refused send that must not spend a budget, or a store directory that changes. No Courier or Knock text was copied.

### Held-out set (new, frozen before the code change)

Local branch `heldout-2026-10-b` (commit `bd10f56`, never pushed): five tasks `g1` to `g5`, six outcome criteria each, a checker
per task, a correct reference solution and two broken ones per task (the checkers were run: 6 of 6 for the correct reference; broken
ones fail the intended criteria). Writer: a fresh Sonnet agent (`claude-sonnet-5-5`, empty configuration directory, working
folder outside the repository) shown only the user-problem sentence of the README and the task format (`WRITER-SPEC.md` in that
commit). It was not shown the repository, this file, the research, the product, the earlier tasks or any arm, and it was not told
any loss class of ours. The controller did not read the task prompts or criteria before the gate. After the gate the set is
published in the evidence folder and counts as seen.

### Measurement path (owner decision): Claude Agent SDK

Every `claude -p` call of this round goes through `~/claude-kredi-runs/sdk-shim/claude`, which calls `claude_agent_sdk.query()`
with the same installed CLI (2.1.308; Agent SDK for Python 0.2.172). The runner calls it through `H2H_CLAUDE_BIN`. The claim
of the hand-over was that the only measured difference to the CLI path is the desktop app's `Artifact` tool and the
`artifact-diagramming` skill. Measured on the init message of a baseline cell (SDK path) against a round-4 courier cell
(CLI path): the SDK path has 24 tools against 17 (it adds CronCreate, CronDelete, CronList, DesignSync, EnterWorktree,
ExitWorktree, ListAgents, Monitor, PushNotification, ReportFindings, ScheduleWakeup, SendMessage, TaskStop, ToolSearch, Workflow,
and lacks AskUserQuestion, EnterPlanMode, ExitPlanMode, Glob, Grep, KillShell, TaskOutput, TodoWrite), 18 skills against 44
(the round-4 CLI cells listed 26 user-level skills of the machine owner such as `caveman`, `impeccable` and `hallmark`, so
the CLI-path plugin arms of round 4 saw them), three built-in plugins (`cc-plugin-agents-md`, `cc-plugin-telemetry`,
`cc-plugin-plugin-authoring`), a 1,000,000 token context window and list-price cost basis. All arms of this round run on the SDK
path, so they see the same environment. Cost per run on the SDK path is not comparable with round-4 costs. Round-3 and round-4
cells (CLI path) are not reused in any gate table of this round.
The shim writes JSON with a space after the colon; `run.mjs` was fixed to read cost, turns and Skill calls from that format
(commits `5621c14`, `6de5e4a`).

### Protocol

1. Product change (decisions above), tests (`npm test`, `claude plugin validate .`), a Sonnet review, commit and push of the
   build under test. After this the product does not change again in this round.
2. Held-out set, Haiku (`claude-haiku-5-5`), arms ours, baseline, knock, knock-inv, courier, courier-inv, 3 runs each (90 cells),
   arms pinned as in round 4 (Knock `cc99682`, Courier `18c7bcb`), runner parallelism 3, hash guard before and after every cell.
3. Then the same held-out set on Sonnet (`claude-sonnet-5-5`), same arms, 3 runs each, with the same build. No cell is reused.
4. Scoring: the six outcome criteria of each task are decided by the task's checker script; every cell of every arm is scored in one
   `score.mjs` call, so scoring order does not exist as an input and there is no model grader. The scorer and the checkers are not
   changed after the runs. Parse failures (a checker that prints no result) are listed, not hidden.
5. Rules as in round 3: Rule B (ours strictly above every other arm on every task; if another arm is at the maximum, ours must be too),
   Rule A (our lost points at most 80 percent of the best other arm's lost points; best other arm means the better of plain and
   invoked per competitor), ceiling rule, and the cost rule: mean cost per run of ours not above the baseline's, both measured in
   this environment. Each model is judged separately.
6. If the held-out set passes on both models: the public set Z1 to Z6 on both models with all arms, 3 runs each; F6 (a fresh agent re-runs
   and re-scores a random 10 percent of cells) and F9 (Opus, one run per task for ours, the best rival and baseline). If a step is not reached
   because of the credit guard or the spending rule, the result so far is written and no claim beyond it is made.
7. Spending: the sum of `total_cost_usd` over all headless runs of this session is capped at 25 USD (file
   `proactive-gate-r5-cost.tsv`); a batch does not start when the spent amount plus the estimate of that batch (from the
   measured cost of the previous batch) exceeds 24 USD. A run with a 429 or an authentication error stops everything and is reported.
   A cell lost to a rate limit or API error is deleted and run again, never graded.
8. Claim scope: only the arms run, the tasks run, the models run and the date. The held-out set seen once is not held-out again.

## Results, round 5 (held-out set, Haiku and Sonnet; public set not run)

Date 2026-10-22. Build under test `5dbfaf3` (protocol frozen in `6140b94`, before the product change). Held-out set: five new tasks
g1 to g5 (6 outcome criteria each), written by an agent that saw neither the code nor these documents (branch
`heldout-2026-10-b`, commit `bd10f56`, published in the evidence folder now that it has been used). Six arms, 3 runs per cell, 90 cells
per model, all on the Claude Agent SDK path, no cell reused, scoring by the task checkers. Evidence folder, with every cell
(redacted), the grades, `score.py` (recomputes every number below; `python3 score.py --check SUMMARY.md` passes), arms, environment,
reproduction and verification steps and `SHA256SUMS`: `bench/head-to-head/results/round5-heldout/`.

| model | ours | baseline | knock | knock-inv | courier | courier-inv | gate |
|---|---|---|---|---|---|---|---|
| Haiku (30 max) | 28.00 | 25.33 | 25.33 | 27.00 | 24.67 | 27.00 | PASS |
| Sonnet (30 max) | 27.00 | 28.33 | 28.00 | 27.00 | 29.00 | 28.00 | FAIL |

Per task (ours, best other arm), Haiku: g1 4.00 against 3.00; g2 6.00 (knock-inv and courier-inv also 6.00); g3, g4, g5 all arms 6.00.
Sonnet: g1 3.00 against 5.00 (baseline and courier); g2 to g5 all at the maximum except baseline on g2 (5.33).

- Haiku: Rule B passes on every task (ties at the maximum count, as the rule says), Rule A passes (lost 2.00 against 3.00 for the best
  other arm; limit 2.40), cost rule passes (ours 0.010 USD per run, baseline 0.012).
- Sonnet: Rule B fails on g1 (3.00 against 5.00), Rule A fails (lost 3.00 against 1.00 for courier; limit 0.80), cost rule fails
  (ours 0.095 USD per run, baseline 0.093; 1.02 times). The gate is not passed, so the public set Z1 to Z6, F6 and F9 were not run.
- Three of the five tasks are saturated (every arm at 6.00 on both models); the Haiku result rests on g1 and g2.
- g1 post-hoc (not a rule): Sonnet's ours cells all refused daytime marketing texts with a rule the task never stated (an opt-out notice required in
  the message body), so three criteria failed for one reason. The checklist rules of `5dbfaf3` do not forbid adding such a block.
- Ours never wrote the library into a solution (0 of 15 on each model); it wrote 94 lines on Haiku against 120 for baseline, 68 against 86 on Sonnet.
- Departures from the protocol, harness fixes and the two API keys used during the run are listed in `results/round5-heldout/SUMMARY.md`.
- Claim scope: no claim of "first" or "best". On this held-out set the plugin beats every other arm's total on Haiku and loses to four of five other arms on Sonnet.

## Round 6 (frozen 2026-10-23, owner decision, before any round-6 code change and before any round-6 scoring run)

Written and committed before the product change and before any scoring run; not edited after results are seen. Later facts go into a
new section. Evidence folders: `bench/head-to-head/results/round6-*/`. Analysis behind these decisions: `docs/BEST-RIVAL-round6.md`
(commit `e8f53b3`, corrected in `2a09dfd`).

### Rulings (general classes only; criteria, checkers, tasks and the win rule do not change)

- **G1 class, "a block the request does not state".** Rule written into the skill: every refusal or block must trace to the request, or to a rule or
  legal text the request names, as a requirement on the sender before sending. A recommendation, a copy guideline, or a check on the content of
  the message body is not a reason to block; the function allows the message and the answer lists it as a note ("not enforced: ..."). When unsure, record
  and explain, do not block. Evidence: 17 of 18 Haiku and 12 of 18 Sonnet g1 cells over all six arms carry an opt-out-notice block the task never
  stated; the rivals have no rule that prevents it (best-rival document, sections 3 and 4). The existing opt-out rule is limited to opt-outs that the data carries
  (a field or an inbound STOP), never to message wording.
- **Cost class (Sonnet turns and cost).** Shorter checklist; one file, then one self-check run as an inline command (no extra test file); no second
  verification turn. The cost rule is unchanged: ours not above the baseline measured in the same environment.
- The `description` line of the skill is unchanged.

### Development gate (BEST-RIVAL-SPEC item 6; separate section of the evidence folder, never in a score table)

After the product change, tests and review: round-5 held-out set (`results/round5-heldout/tasks`, seen, no longer counts), tasks g1 to g5,
both Haiku and Sonnet, ours x3, SDK path, scored by the same checkers. Compared with the best rival's published round-5 score on each task
(Haiku g1 3.00, g2 6.00, g3 to g5 6.00; Sonnet g1 5.00, g2 to g5 6.00): ours must be strictly higher, or at the ceiling together with the rival,
on every task of both models (no tie below the ceiling). If not: no new held-out measurement; analyse the lost criteria, make a general fix, test and
review, repeat. At most 3 iterations; each is recorded with its cost.

### New held-out set (c)

A fresh Sonnet agent (clean configuration directory, folder outside the repository) writes 5 tasks from the README user-problem sentence and the
task-template format only. It is not shown the product code, this file, the research or best-rival reports, any earlier held-out set or any loss class.
Local branch `heldout-2026-10-c`, never pushed. The controller does not read the task prompts or criteria before the gate. Published in the evidence
folder after the gate.

### Protocol

1. Dev gate passes on both models (or the 3 iterations are used up and the result is reported as it stands).
2. Held-out c, all six arms (ours, baseline, knock, knock-inv, courier, courier-inv; pins as in round 5: Knock `cc99682`, Courier `18c7bcb`), 3 runs each, on Haiku
   (`claude-haiku-5-5`) and on Sonnet (`claude-sonnet-5-5`) separately, SDK path (`~/claude-kredi-runs/sdk-shim/claude` through `H2H_CLAUDE_BIN`), runner
   parallelism 3, hash guard before and after every cell. No cell is reused from any earlier round.
3. Scoring: the outcome criteria of each task are decided by the task's checker script. One `score.mjs` call scores every cell of every arm together, so no scoring order
   exists as an input. There is no model grader, so the "three votes in shuffled order" rule of the model-graded repositories has nothing to apply to here; the
   deterministic checker output is the single vote. Parse failures are listed.
4. Rules, stated together and reported side by side: Rule A (our lost points at most 80 percent of the best other arm's lost points, best other arm = the better of plain and
   invoked per competitor), Rule B (ours strictly above every other arm on every task; at the maximum if another arm is), and **Rule B-prime**, frozen here as
   `EVIDENCE-SPEC.md` "Win rule" defines it: "In each set (public and held-out, separately), ours is strictly higher than every other arm on every task, or at the
   ceiling together with the best arm, except on at most one task. On that one task our deficit to the best other arm is at most 0.34 points (one criterion in one of
   three runs on a 5-point task)." Plus the cost rule (ours not above the baseline of the same environment). Rule A, the cost rule and Rule B-prime must pass; Rule B is reported.
   Each model is judged on its own. The launch sentence says which rule passed.
5. Public set Z1 to Z6 (`bench/head-to-head/tasks/Z.md`, checkers `z1.mjs` to `z6.mjs`): all six arms, 3 runs, both models, SDK path, no reuse (earlier public rounds ran on the CLI
   path and are not reused). If the budget guard stops a batch, the arms and tasks run so far are reported and nothing beyond them is claimed.
6. If held-out c and the public set both pass (Rule A and Rule B-prime): F9 (Haiku and Opus, one run per task for ours, the best rival on that task, and the baseline; public and held-out)
   and F6 (10 percent of cells, re-run and scored independently by an agent that has not seen the code; agreement rate reported).
7. Measurement path: every `claude -p` call goes through the Agent SDK shim. Known differences between the SDK path and the old CLI path: the desktop app's `Artifact` tool and the
   `artifact-diagramming` skill do not exist on the SDK path; CLI-path cells also saw the machine owner's user-level skills (for example `caveman`, `impeccable`; 44 skills
   against 18 in the round-5 diagnosis); measured in round 5: 24 tools against 17, three built-in plugins, a 1,000,000 token window. CLI-era cost and behaviour figures are
   therefore not comparable with SDK-path figures. No cell from an earlier round is reused in any gate table of this round; any rival cell shown from an older round (none planned)
   would be marked as CLI path.
8. Spending: sum of `total_cost_usd` over all headless runs of this session in `~/claude-kredi-runs/2026-10-22/proactive-gate-r6-cost.tsv`, at most 30 USD; the controller itself
   has a hard 7 USD limit. A batch does not start when the spent amount plus the estimate of that batch (from the measured cost of the previous batch) exceeds 29 USD. A 429 or an
   authentication error, or the shim's "credit guard" refusal (exit 3), stops everything and is reported. A cell lost to a rate limit or API error is deleted and run again, never graded.
9. Claim scope: only the arms, tasks, models and date that were run. "First" is claimed only when the full gate passed, with its scope. Evidence folder per
   `EVIDENCE-SPEC.md` (11 items), development gate in its own section.

## Results, round 6 (held-out set c on Haiku only; Sonnet and public set not run)

Date 2026-10-23. Build under test `671b716` (protocol frozen in `6179934`, best-rival analysis `e8f53b3`/`2a09dfd`, before any code change). Held-out set c: five tasks
g1 to g5 (6 outcome criteria each) written by a fresh Sonnet agent that saw only the README user problem and the task format (local branch `heldout-2026-10-c`,
`87db60a`, never pushed; published in the evidence folder now that it has been used). Haiku, six arms, 3 runs per cell, 90 cells, SDK path, no cell reused, scored by
the task checkers. Evidence: `bench/head-to-head/results/round6-heldout-c/` (`python3 score.py --check SUMMARY.md` passes; `SHA256SUMS` verifies).

| model | ours | baseline | knock | knock-inv | courier | courier-inv |
|---|---|---|---|---|---|---|
| Haiku (30 max) | 29.00 | 28.00 | 27.00 | 26.00 | 27.00 | 27.00 |

Per task (ours / best other): g1 6.00 / 5.67; g2 6.00 / 5.67; g3 5.00 / 6.00 (baseline); g4 6.00 all; g5 6.00 / 6.00.
Rule A passes (lost 1.00, limit 1.60); cost rule passes (0.84 times the baseline); Rule B fails on g3; Rule B-prime fails (one exception task, deficit 1.00, limit 0.34).
The gate is not passed. Sonnet (about 9.5 USD) and the public set Z1 to Z6 were not run because the session's hard spending cap left no room; F6 and F9 were not run.
Development gate (ours x3 on the seen round-5 set): iteration 1 (`62c1340`) Haiku 29.33, Sonnet 30.00; iteration 2 (`671b716`) 30.00 on both; passed at iteration 2
(`results/round6-devgate-iter1`, `-iter2`, kept out of every score table).
Post-hoc (not a rule): in the failing g3 cell, ours returned sentence refusals although the task asks for snake_case codes (skill rule 8 conflicts with a requested return shape)
and invented an "EU opt-in" block (rule 2(d) default). Candidate general fixes for a next round: the requested return shape beats rule 8; a promotion default may not cite a law the request does not name.
Claim scope: no claim of "first" or "best". On this one set and one model ours has the highest total, ahead of baseline by 1.00, and loses one task.

## Round 7 (frozen 2026-10-23, owner decision, before any round-7 code change and before any round-7 scoring run)

Written and committed before the product change and before any scoring run; not edited after results are seen. Later facts go into a new section.
Evidence folders: `bench/head-to-head/results/round7-*/`. Analysis behind these decisions: `docs/BEST-RIVAL-round7.md` (commit `14b6c20`).

### Rulings (general classes only; criteria, checkers, tasks and the win rule do not change)

- **G3 class, "a block for a signal the interface cannot carry".** Evidence (round 6, held-out c, Haiku): in 1 of 3 ours cells and in the 3-score cells of knock, knock-inv, courier and
  courier-inv, `mayEmail` held marketing for every address "with no opt-in on record" although the request's functions (`unsubscribe`, `resubscribe`, `mayEmail`) can record only opt-outs and
  re-sign-ups; so every new address was held and the checker's criteria 1, 2 and 6 failed. The baseline (3 of 3 at 6/6) allowed marketing when no opt-out was recorded and
  wrote the EU gap in its answer. Rule written into the skill (rule 2, with the matching clause in rule 11): when the request's functions record only opt-outs and give no way to record
  an opt-in, a missing opt-in is not a block: allow when no opt-out is recorded, and write "not enforced: opt-in (the interface cannot record one)" in the answer. Data or a function
  that does carry opt-ins keeps rules 2(a) to (d) unchanged.
- Rule 8 is not changed. The round-6 post-hoc note in `results/round6-heldout-c/SUMMARY.md` (a conflict between rule 8 and a snake_case return shape on g3) does not apply to g3: its prompt asks for
  "a short sentence" in `reason`. The note stays in that folder as written; this section corrects it.
- Cost class and the `description` line are unchanged; the skill must not grow beyond its round-6 byte size plus 400 bytes.

### Development gate (BEST-RIVAL-SPEC item 6; separate section of the evidence folder, never in a score table)

After the product change, tests and review: ours x3, SDK path, both models (`claude-haiku-5-5`, `claude-sonnet-5-5`), scored by the task checkers, on (i) the round-5 held-out set
(`results/round5-heldout/tasks`) and (ii) the round-6 held-out set c (`results/round6-heldout-c/tasks`). Both sets are seen and no longer count for scoring. Reference scores, from published results:
(i) Haiku g1 3.00, g2 to g5 6.00; Sonnet g1 5.00, g2 to g5 6.00 (round 5). (ii) Haiku g1 5.67, g2 5.67, g3 6.00, g4 6.00, g5 6.00 (round 6 best other arm per task). No rival result exists for set c on
Sonnet; there, ours must be at the task maximum (6.00) on every task, because no lower reference exists. Pass: on every task of every set and model, ours is strictly above the reference or at the ceiling together
with it. If not: analyse, make a general fix, test and review, rerun. At most 3 iterations, each recorded with its cost. Set (i) is rerun in an iteration only if the code change since the previous run can touch it
(any change to the skill); in practice every iteration reruns both sets.

### New held-out set (d)

A fresh Sonnet agent (clean configuration directory, folder outside the repository) writes 5 tasks from the README user-problem sentence and the task-template format only (same `WRITER-SPEC.md` as set c).
It is not shown the product code, this file, the research or best-rival reports, any earlier held-out set or any loss class. Local branch `heldout-2026-10-d`, never pushed.
The controller does not read the task prompts or criteria before the gate; it runs the checkers on the writer's references and prints scores only.

### Protocol

1. Dev gate passes on both models for both sets (or the 3 iterations are used up and the result is reported as it stands).
2. Held-out d: all six arms (ours, baseline, knock, knock-inv, courier, courier-inv; pins Knock `cc99682`, Courier `18c7bcb`), 3 runs each, on Haiku and on Sonnet separately, SDK path
   (`~/claude-kredi-runs/sdk-shim/claude` through `H2H_CLAUDE_BIN`), parallelism 3, hash guard before and after every cell. No cell is reused from any earlier round. Haiku first, then Sonnet.
3. Scoring: the outcome criteria are decided by the task checkers; one `score.mjs` call scores every cell of every arm together (no model grader, so no votes or order).
4. Rules, stated together and reported side by side: Rule A (our lost points at most 80 percent of the best other arm's lost points), Rule B (ours strictly above every other arm on every task; at the maximum if another
   arm is), and **Rule B-prime**, verbatim from `EVIDENCE-SPEC.md` "Win rule": "In each set (public and held-out, separately), ours is strictly higher than every other arm on every task, or at the ceiling together
   with the best arm, except on at most one task. On that one task our deficit to the best other arm is at most 0.34 points (one criterion in one of three runs on a 5-point task)." Applied to 6-point tasks as the
   absolute 0.34 points (as in round 6; the owner has not changed it). Plus the cost rule (ours not above the baseline of the same environment). Rule A, the cost rule and Rule B-prime must pass; Rule B is reported.
   Each model is judged on its own.
5. Public set Z1 to Z6, all six arms, 3 runs, both models, SDK path, no reuse. It starts only if the spent amount plus its estimate (from the measured cost of the previous batch) fits the budget; if it does not,
   it is not started and the report says so.
6. F9 (Haiku and Opus, one run per task for ours, the best rival per task, and the baseline) and F6 (10 percent of cells re-run and scored independently by an agent that has not seen the code) run only if held-out d
   and the public set both pass Rule A and Rule B-prime on both models.
7. Measurement path: every `claude -p` call goes through the Agent SDK shim. Known differences between the SDK path and the old CLI path: the desktop app's `Artifact` tool and the `artifact-diagramming` skill do not exist
   on the SDK path; CLI-path cells also saw the machine owner's user-level skills (for example `caveman`, `impeccable`; 44 skills against 18 in the round-5 diagnosis; 24 tools against 17, three built-in plugins, a 1,000,000
   token window). CLI-era cost and behaviour figures are therefore not comparable with SDK-path figures. No cell from an earlier round is reused in any gate table of this round.
8. Spending: every headless run's `total_cost_usd` goes to `~/claude-kredi-runs/2026-10-22/proactive-gate-r7-cost.tsv`; total at most 22 USD; the controller has a hard 7 USD limit, and round 6 showed that this meter
   also counts the benchmark runs. A batch does not start when the amount spent plus the batch estimate would pass either limit. A step whose estimate does not fit is not started; the evidence up to that point is written.
   A 429, an authentication error or the shim's "credit guard" refusal (exit 3) stops everything and is reported. A cell lost to a rate limit or API error is deleted and run again, never graded.
9. Claim scope: only the arms, tasks, models and date that were run. "First" is claimed only when the full gate passed, with its scope. Evidence folder per `EVIDENCE-SPEC.md` (11 items); development gate in its own section.

### Round 7, development-gate iteration 1 and the iteration-2 rulings (frozen 2026-10-23, before the iteration-2 code change and run)

Iteration 1 (build `78506d4`, cost from `costUsd` of the cells: see `results/round7-devgate-iter1-*`): did not pass. Ours totals of means (30 max): round-5 set Haiku 29.33, Sonnet 28.00;
held-out c Haiku 28.33, Sonnet 26.67. The g3 loss of round 6 is gone (g3 6.00 on both models and both sets). The failing cells, by general class:

- **Transactional held by quiet hours** (c g2: Haiku 3 runs of 3 lose one or two criteria, Sonnet 3 of 3). The request says "a customer who is waiting for a courier must still hear about the courier"; the
  agent applied the customer's quiet window to transactional pushes too. Skill rule 9 ("Opt-out, quiet hours and legal hours still apply to it") is written for a message the user asked to be told at a time,
  and an agent reads it as covering transactional messages. Ruling: a message the request says must still reach the person (receipt, security code, courier arrival) is not held by quiet hours or by a
  marketing cap and does not count toward the cap; its own channel's opt-out and legal hours still apply. A message held for any reason spends no budget.
- **A self-chosen window narrower than the law** (c g1, Sonnet 2 of 3: window 09:00 to 20:00 "because of the complaint"; edge, DST and `nextAllowedAt` criteria fail). The request asks for care about when to text
  and states no hours. Ruling (extension of the round-6 rule 11): when the request asks for care about contact hours and states none, use the legal window of the recipient's region (US: 08:00 to before 21:00 recipient-local);
  a narrower window only when the request states it.
- Not addressed (no general cause found in the transcripts): round-5 g4 Sonnet run 3 scored 0 (all criteria failed in one run of three); round-5 g2 Haiku run 2 and c g5 stop-word false positives
  (one run each on Haiku and Sonnet) are single-run variance; the skill already states rule 7 (STOP as the whole message).
- Size: the round-7 cap in the first Round 7 section (round-6 size plus 400 bytes) is raised to round-6 size plus 900 bytes (7663 bytes) because two rulings are added; no other cap changes.
- Iteration 2 reruns both sets on both models, ours x3, same checkers, same references. Iteration 3 only if iteration 2 fails and the budget fits (protocol item 8).

### Round 7, development-gate iteration 2 result and the iteration-3 ruling (frozen 2026-10-23, before the iteration-3 code change and run)

Iteration 2 (build `044544c`, cell cost 3.22 USD, `results/round7-devgate-iter2-*`): did not pass. Totals of means (30 max): round-5 set Haiku 29.00, Sonnet 29.00; held-out c Haiku 25.67, Sonnet 28.00.

- **Regression caused by the iteration-2 wording (general class: a legal-hours default applied to a message the law does not limit).** Round-5 g1 criterion 6 ("transactional text is allowed at night") fails in 6 of 6 cells (reason
  `outside_legal_hours`, Haiku and Sonnet); in iteration 1 it passed. The rule-6 sentence "use the legal window of the recipient's region" was read as covering every text. Ruling: the legal-window default applies to
  unsolicited and promotional messages only; a transactional message (the request's own words for a message that must still reach the person) is not held by it. This replaces the iteration-2 rule-6 sentence; rule 9 is unchanged.
- **Checker nondeterminism, not a product defect (report to the owner; the checker is not changed).** Held-out c g2 criterion 4 failed in 5 of 6 cells in iteration 2 and 5 of 6 in iteration 1. The code of cell `ours-g2-2` (Sonnet) is correct on reading
  (transactional returns `send: true` before any counting). Running the unchanged checker six times on that same folder gave 5, 4, 5, 5, 4, 4 of 6. Cause: `checkers/lib.mjs` loads the module with `import(url + "?v=" + Date.now())`; two criteria that load within the
  same millisecond share one module instance, so the state of the previous criterion (user `u` already at the cap on 2026-06-02) leaks into criterion 4. Every arm is exposed to it; the earlier round-6 Haiku 6/6 on g2 had no collision. The criteria, checkers and win rule stay as frozen;
  the effect is reported next to every held-out c number it touches, and the iteration-3 pass test uses g2 as measured.
- c Haiku g3 opt-in block returned in 2 of 3 cells and g5 stop-word false positives in 3 of 3 cells (Haiku): no new rule; both are existing rules (2 exemption, 7) that the Haiku cells did not apply. Not changed.
- Iteration 3 is the last allowed iteration of this round. If it fails, the round stops: held-out d is not written or run, and the report states the dev-gate result as it stands.

## Results, round 7 (development gate only; held-out d, public set, F9 and F6 not run)

Date 2026-10-23. Rulings frozen before each code change (`231c4cf`, `7994a27`, `c3a119a`); best-rival analysis `14b6c20`. Ours x3, SDK path, Haiku and Sonnet, on the seen round-5 set and the seen held-out set c, same checkers, references as frozen.
Evidence: `bench/head-to-head/results/round7-devgate/` (`python3 score.py --check SUMMARY.md` passes; `SHA256SUMS` verifies; departures in `NOTES.md`).

| iteration | build | r5 Haiku | r5 Sonnet | c Haiku | c Sonnet | gate | cell cost USD |
|---|---|---|---|---|---|---|---|
| 1 | `78506d4` | 29.33 | 28.00 | 28.33 | 26.67 | FAIL | 3.12 |
| 2 | `044544c` | 29.00 | 29.00 | 25.67 | 28.00 | FAIL | 3.22 |
| 3 | `6bdfc6c` | 28.67 | 30.00 | 26.33 | 27.00 | FAIL | 3.26 |

What changed: the g3 loss class of round 6 is fixed (c g3 6.00 on both models in iteration 1; it recurs in single runs of iterations 2 and 3, 4 of the 24 g3 cells of iterations 2 and 3 (both sets, both models) scored 2 or 3). A legal-window default added in iteration 2 produced extra blocks
(transactional text at night in iteration 2, email and g5 texts held for legal hours in iteration 3) and should be removed. Held-out c g2 criterion 4 is hit by a checker race (see `NOTES.md`). Per the frozen rule the round stops after three iterations:
no new held-out set (d) was written, no Sonnet or public measurement was run, and no claim of "first" or "best" is made. Total cell cost of the gate 9.60 USD.

## Round 8 (frozen 2026-10-23, research and development only; no measurement in this round)

Written and committed before any round-8 code change. Analysis, evidence and the technique map: `docs/BEST-RIVAL-round8.md`. Criteria, checkers, tasks and the win rule do not change.

Rulings (details and evidence in the analysis, section 6):

- R8-1. Rule 6 loses the legal-window default sentence added in round 7 iteration 2 (measured regression in iterations 2 and 3).
- R8-2. A tested helper file `skills/proactive-gate/references/gate-kit.mjs` (local time, DST, next open time, day and week keys, STOP parsing, atomic claim and counter), appended to the agent's file by one shell command.
- R8-3. A refusal sentence names the retry time as local clock time and zone name; the instant is a separate field.
- R8-4. A hold applies to the interrupting surface; a silent in-app item stays.
- R8-5. A suppression lasts to the end of the recipient's local day unless the request says longer.
- R8-6. Skill size cap 9,000 bytes (amended from 8,000 before any code change). R8-7. The hook line no longer points at the library. R8-8. New development set k, committed before any run, with a collision-free checker loader. R8-9. Every new test has a mutation check.

The launch claim under the owner decisions of 2026-10-23 is "first in total" (interval of ours minus the best other arm's total above zero). On a saturated set (best rival at 29 of 30) that interval cannot exclude zero; the development gate therefore includes the discriminative set k.

- R8-6b (2026-10-23, after the Sonnet review of the skill text and before any run). Cap raised from 9,000 to 9,700 bytes and the front page from 40 to 46 lines: the review found that the compression had dropped three conditions of the rule-2 exception and that rules 5, 6, 8 and 9 could be over-read; the clarifying clauses and the kit paragraph cost 690 bytes (about 0.0002 USD of cached input per turn). Changes made from that review: rule 2 exception restored with its conditions; rule 5 says a message id's claim never expires; rule 6 per-surface hold only when the task defines a silent surface; rule 8 puts the instant in the task's result shape; rules 9 and 11 point to rule 6 for hours; the append command gets a newline guard and a fallback path.

### Round 8, development-gate iteration 1 result and the iteration-2 rulings (frozen 2026-10-23, before the iteration-2 code change and run)

Iteration 1 (build `71fdf25`, `results/round8-devgate/iter1/NOTES.md`): not passed. Sonnet: set k ours 28.33 against courier-inv 26.33, interval of the difference [1.00, 3.00] (P1 pass), r5 30.00, c 30.00, cost 0.66 of the baseline (P3 and P4 pass), P2 fails on k3 (5.00 against 6.00).
Haiku: k 18.33 against 25.33 (P1 fail), c 27.33 against 28.00 (P3 fail). Rulings, each a general class seen in the ours cells (criteria, checkers and the protocol are unchanged):

- R8-10. HELP and INFO. A text-message program that handles STOP and START also answers HELP (and INFO) with a short reply and changes nothing (CTIA Messaging Principles; Twilio default keywords). Evidence: k3 criterion 5 failed in 6 of 6 ours cells on both models; the kit and rule 7 named STOP and START only. Kit: `gkIsHelp(text)`; rule 7 gets one sentence.
- R8-11. A consent rule needs a carrier. Rule 2(c) and (d) hold a promotion that has no opt-in on record; when neither the data nor the functions the request or the app exposes can carry an opt-in, the check can only hold every message. Evidence: Haiku k1, 3 of 3 runs scored 0 because every text was refused for "no consent on record" while the user object had no consent field. This extends the round-7 opt-in exception (email and in-app only) to every channel; a recorded opt-out still blocks, and the answer says "not enforced: opt-in (the interface carries none)".
- R8-12. Security alerts and receipts are transactional by nature. A sign-in alert, a password change, a one-time code or a receipt is not held by quiet hours or a marketing cap whether or not the request says so; a reminder or digest the user asked for is not transactional. Evidence: Haiku k4, 2 of 3 runs held a security alert at night.
- R8-13. A repeat of a message id returns the same answer; only the send and the count are not repeated, and a silent in-app item is reported every time. Evidence: k4 criterion 6, 2 of 3 runs on each model reported the inbox item only on the first call.
- R8-14. Size: cap 10,300 bytes (the library paragraph is required by existing tests and stays). Haiku cells where the skill was not called are not changed by any rule.

## Results, round 8 (development gate, then one final measurement; NOT a valid measurement: isolation failure)

Date 2026-10-23, build `5fe287e`, subscription path. Details: `bench/head-to-head/results/round8-devgate/iter1/NOTES.md`, `iter2/NOTES.md`, `bench/head-to-head/results/round8-final-evidence/` (`SUMMARY.md`, `ISOLATION.md`).

- Development gate (set k, written by a fresh Sonnet agent that was shown a list of difficulty areas, and the seen sets r5 and c): iteration 2, Sonnet k 28.33 against courier-inv 26.33 (+2.00, interval [1.00, 3.00]), r5 30.00, c 30.00, cost 0.68 of the baseline. Haiku k 28.33 against 25.33, c 27.00 against 28.00, cost 1.02 of the baseline.
- Final measurement per `docs/FINAL-PROTOCOL-round8.md`, Sonnet, six arms, 3 runs: public set 26.00 of 36 against the baseline's 28.00 (-2.00, interval [-4.00, -1.00]); held-out set d 29.67 of 30 against courier's 27.33 (+2.33, interval [-0.33, 4.00]). Claim I1 is not met on either set. F6-grader (second scoring pass over all 198 cells): no cell differs, criterion agreement 100 percent. F9 and F6-runs were not completed.
- Every cell of the gate and of the final measurement ran below /Users/efe, so the owner's global CLAUDE.md was loaded as project memory in every arm (88 of 108 public and 74 of 90 held-out transcripts mention the caveman skill it names). The numbers above are a record, not a result. Held-out set d was read by the scoring run and is no longer held-out.
- Why the public set was lost (cells of `z-sonnet`, to be re-read after a clean rerun): Z2 criterion 1 (a digest at 07:59 local sent) after the round-7 legal-window default was removed; Z3 categories and failed-push budget; Z1 timezone placeholder and the 24-sends concurrency criterion; Z6 local time in the text.
