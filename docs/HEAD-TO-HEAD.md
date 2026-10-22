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
