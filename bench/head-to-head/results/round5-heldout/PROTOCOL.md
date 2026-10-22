# Protocol of round5-heldout

Frozen protocol: section "Round 5 (frozen ...)" of `docs/HEAD-TO-HEAD.md` in this repository, committed in `6140b94` before the first run of this round.

Link: `docs/HEAD-TO-HEAD.md` at commit `6140b94` (`git show 6140b94:docs/HEAD-TO-HEAD.md`).

Verbatim copy of the section as it is in the working tree when this folder was built (compare with the committed version using the command above; the section is not edited after results are seen):

---

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
