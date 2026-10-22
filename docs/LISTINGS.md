# Listings

Text for each store this repository appears in. Submitting is done by the maintainer, not by a
task. The one category sentence is in `docs/category-sentence.txt`.

## npm (`proactive-gate`)

- Title: proactive-gate
- Short description (the `description` field of `package.json`): proactive-gate is a library that decides whether an AI agent may message a user right now (quiet hours, daily limit, consent, snooze) and records the reason when it may not.
- Keywords (the `keywords` field): `ai`, `agents`, `proactive`, `notifications`, `quiet-hours`, `consent`, `rate-limit`, `budget`, `llm`, `policy`, `presets`, `langchain`, `mastra`, `ai-sdk`, `openai-agents`, `claude-code`, `guardrails`, `agent-guardrails`, `notification-budget`, `proactive-ai`, `python`, `conformance`, `notification-throttle`, `frequency-cap`, `notification-fatigue`, `proactive-agent`, `do-not-disturb`, `tcpa`, `timezone`, `agent-notification-policy`
- Search phrases this listing is written for: quiet hours notifications library, notification frequency cap per user, limit how often my AI agent notifies users, proactive agent notification policy, notification fatigue AI agent, TCPA quiet hours check.

## PyPI (`proactive-gate`)

- Title: proactive-gate
- Summary (the `description` field of `python/pyproject.toml`, at most 512 characters): proactive-gate is a library that decides whether an AI agent may message a user right now (quiet hours, daily limit, consent, snooze) and records the reason when it may not.
- Keywords: the `keywords` list in `python/pyproject.toml`.
- Classifiers: unchanged from the 6 September pass (Artificial Intelligence, Communications, Typing :: Typed, MIT).

## pkg.go.dev (`github.com/Bubblegunn/proactive-gate/go`)

- Import path: `github.com/Bubblegunn/proactive-gate/go/proactivegate` (the package in `go/proactivegate/`).
- Package synopsis (quoted from the doc comment at `go/proactivegate/types.go:1`): Package proactivegate is an independent Go implementation of the proactive-gate behaviour contract in spec/SPEC.md. It was written from the specification and the fixtures, not ported from the TypeScript source.
- Module install (module path `github.com/Bubblegunn/proactive-gate/go`, tag `go/v0.2.0`, the line from `go/README.md`): `go get github.com/Bubblegunn/proactive-gate/go@v0.2.0`

## skills.sh

- Name: `proactive-gate`
- Description (quoted from `skills/proactive-gate/SKILL.md`): Use when you need to send reminders, texts, emails or pushes to users from an agent, cron job or webhook and must limit how many messages they get, respect quiet hours, do not message people at night, handle opt-out and STOP, keep to legal contact hours, explain why a user got nothing, or replay last week under a new policy. The proactive-gate library checks consent, time zone, quiet hours, snooze and budgets before each unsolicited message and gives every refusal a reason and a retry time.
- Install (unverified, not checked against skills.sh): `npx skills add Bubblegunn/proactive-gate`. The command form is the one documented in https://github.com/vercel-labs/skills/blob/main/README.md. Whether skills.sh lists this repository and detects `skills/proactive-gate/SKILL.md` has not been checked.
- Keywords: quiet hours, notification budget, proactive agent, consent, daily limit, agent skill.

## Claude Code plugin directory

- Name: `proactive-gate`
- Description (quoted from `.claude-plugin/plugin.json`): Teaches a coding agent to put quiet hours, message budgets, consent and snooze in front of any message an AI agent sends on its own.
- Install (unverified until the branch is on `main`): `claude plugin marketplace add Bubblegunn/proactive-gate`, then `claude plugin install proactive-gate@proactive-gate`.
- Category: development.

## MCP registries

- Name: `io.github.Bubblegunn/proactive-gate`
- Description: Decide whether an AI agent may message a user right now. Tools `decide` and `explain` evaluate a policy file for one user and one candidate message and return the decision, the check that refused, the reason and `nextAllowedAt`.
- Command: `npx -y proactive-gate mcp --policy ./proactive-gate.policy.json`
- Tools: `decide` (budgets are consumed only when `commit` is true) and `explain` (never consumes a budget).
- Transport: stdio.
- Keywords: quiet hours, notification budget, proactive agent, consent, rate limit.

## Not applicable to this repository

- GitHub Marketplace for Actions: this repository ships no GitHub Action.
- VS Code Marketplace: there is no extension.
- Codex and Cursor plugin directories: there is no Codex or Cursor plugin manifest here.
