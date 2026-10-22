# Handoff for the cloud session (2026-10-22)

This branch (`plugin-leadership`) carries work in progress that has not been released. It continues in a
Claude Code cloud session. The same branch exists in all five repositories: Bubblegunn/proactive-gate,
Bubblegunn/workproof, Bubblegunn/surviving-lines, Bubblegunn/ai-slop-linter, Bubblegunn/product-engineer.
Each was pushed as one squashed commit on top of `main`. Raw benchmark transcripts were left out on purpose.
Only the Markdown summaries under `bench/head-to-head/results/` are included.

## Goal

The goal is that each repository's Claude Code plugin does the user's job measurably better than every
competing plugin in Anthropic's plugin directory, and better than Claude with no plugin. That is proven by a
head-to-head benchmark that anyone can re-run. Only then is the plugin released, submitted to the directory and
launched.

## Win rule (binding)

Per repository the benchmark has 6 public tasks, the competitors' own README examples as extra tasks, and 3
held-out tasks. Each task runs 3 times per arm on Sonnet (`claude-sonnet-5-5`). Only outcome criteria count;
process criteria are reported separately.

- **Rule B:** on every task, our mean is strictly above every other arm. If another arm is at the maximum, we
  must be at the maximum too.
- **Rule A:** our lost points (maximum minus our total) are at most 80 percent of the best other arm's lost
  points.
- **Saturated tasks:** a task where every arm scores full marks is replaced by a harder variant. The variant is
  frozen in a commit before any code change.
- **Competitors:** each competitor also gets an "invoked" arm, where the prompt names its skill. We compare
  against the better of its two arms. Competitors are set up as their README says. A competitor that cannot run
  is reported, never counted as a win.
- **Final gate:** the held-out tasks, plus Haiku and Opus runs (1 per task). No task may be lost on any model.
  Then an independent fresh agent re-runs and re-grades a random 10 percent of cells.
- **Publishing:** nothing about the benchmark is claimed publicly until the full gate passes. Never contact
  competitors.

## Safety rules learned the hard way

- **Never run the Vaara plugin.** It rewrote the global Claude Code settings (hooks and MCP servers) twice.
  Before and after every competitor run, hash the `hooks` object of `~/.claude/settings.json` and the
  `mcpServers` object of `~/.claude.json`. Stop if either changes.
- **Benchmark only an immutable copy of our code** (`git archive <sha>`), and probe a new feature in the copy
  first. Implementers and reviewers never run checkout, restore, stash or reset on the working tree.
- **Rate limits:** run at parallelism 2. Cells that fail on a rate limit are retried and never graded.
- **Headless runs:** `claude -p` needs to be logged in. In a cloud session, check this first, or use an API key.
  The harness takes the model as a parameter.

## Method

Each repository is driven by one Sonnet controller agent using the superpowers subagent-driven-development
method. Haiku implementers write the code (Sonnet where judgement is needed) and Sonnet reviewers check it.

Commit format:
- conventional title and technical body;
- a "Sade dil (teknik olmayan biri için):" block with "- Ne yapıldı:", "- Ne işe yarar:" and, only when
  automation really increases, "- Otomasyon etkisi:";
- `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

product-engineer commits also need "For the customer:" with "What changed:" and "Why it matters:" lines; a hook
enforces this. No personal email addresses anywhere.

## State per repository

Read `docs/HEAD-TO-HEAD.md` in each repository: tasks, rulings, results per round and a "Resume" section.

| Repository | Latest result | Next step |
|---|---|---|
| workproof | passes every public task (34.33 vs 23.33 of 35) | final gate: T6 re-run for ours, held-out tasks (in this branch), Haiku/Opus runs, then the 10 percent audit |
| surviving-lines | 49.00 vs 41.33 of 51; rule A passes; rule B fails only T3 | round 4: T3 writes the `.mailmap` as proposals and hedges; re-run T3 for all arms plus ours on all tasks; then the final gate |
| product-engineer | core 23.00 vs 21.33 (lost 7.00, needs at most 6.93); fails T2, T3, T4, H4, H5 | round 3 (see Resume): act-and-unstage rule for H5, release notes without code identifiers, verdict-only answers, replace T3, fixed H4 answer shape |
| ai-slop-linter | 54.33 vs 56.33 of 60 (blader humanizer, invoked): behind | round 2: `--compare` flags first-person words and new claims, a prompt hook, an agent-checked catalog for tells a regex cannot catch (MIT sources, attribution kept) |
| proactive-gate | Sonnet and Haiku write simple gates correctly without the library | round 3: tasks Z1 to Z6 (under-specified product prompts with public sources), `assistantNudge` preset, `scaffold nudge`, synchronous evaluate, explain; extra rule: our cost per run is not above the baseline's |

Held-out tasks for the other four repositories are on a separate branch, `heldout-2026-10`, in each
repository. They were written by agents that never saw our code. Only the final-gate step may fetch that branch:
`git fetch origin heldout-2026-10`, then check it out into a separate folder. No implementer or reviewer reads
it before that, and the product must not change after it is read.

## Releases needed at launch

| Repository | Version | Reason |
|---|---|---|
| ai-slop-linter | 0.2.0 | the skill needs `--compare` |
| surviving-lines | 0.4.0 | |
| product-engineer | 0.8.0 | `stubs` and `facts` |
| workproof | 0.8.0 | `sessions`, `verdict`, `bullets`, `mine` |
| proactive-gate | next minor | |

Release with `npm run release -- X.Y.Z` after merging. The repository owner gives the go for merges, pushes to
`main`, releases and directory submission.
