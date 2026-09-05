# Changelog

## 0.2.0 (unreleased)

- A behaviour contract in `spec/`: numbered requirements, fixture and policy JSON Schemas, 27 fixtures any language can run, `spec-lint` in CI, and `replay --fixtures`.
- Policy as data: `createGate({ policy })`, `compilePolicy`, `--policy policy.json`, `examples/policy.json`.
- Outcome model: `defer` with `retryAt`, shadow mode, `nearLimit` notes on budgets, `hooks` (before, after, error, finally), a decision `id` and an idempotent `commit`.
- Optional checks `utilityFloor` and `boundedDeferral`, fed by the caller's own model.
- One command releases a version: `npm run release -- X.Y.Z` dates the CHANGELOG entry, sets the version in `package.json`, `CITATION.cff` and `python/pyproject.toml`, tags, pushes, and moves the `v0` major tag. The release workflow starts on full version tags only, so the moving tag cannot start a second publish.
- Fourteen presets with sources under `proactive-gate/presets`, built from `allowedWindow`, `requiresConsent`, `monthlyBudget`, `rateLimit`, `recentInteraction` and `windowBudget`.
- Adapters on subpaths for the Vercel AI SDK, Mastra, LangChain and OpenAI Agents, and a Claude Code `PreToolUse` hook (`proactive-gate hook`).
- A Python sibling in `python/` (sync and async gates, Memory, SQLite and Redis stores) that passes the same fixtures.
- Docs site with a browser playground at https://bubblegunn.github.io/proactive-gate/.
- Runnable adapter examples that need neither the framework nor a network: `examples/mastra/` and `examples/ai-sdk/`, each with a JSON policy and a day of candidates, run by `npm run examples` and pinned by tests.

## 0.1.2 (2026-09-05)

- `SqliteStore` on `node:sqlite` (Node 22.5+), persistence for single-instance deployments, by @aaqib-hafeez-khan-in (#3).
- `weeklyBudget` check keyed on the user's local ISO week, consumed atomically at commit next to the daily one, `defaultChecks({ weeklyLimit })`, by @edwardsong08 (#9, closes #2).

A LangGraph example, a comparison with hand-rolled checks and feature flags, a benchmark (`npm run bench`) with the measured line in the README, and a generated API reference under `docs/api`.

## 0.1.1 (2026-09-05)

Mastra example, a real decision trace in the README, a "Writing your own check" section with a test, Turkish README, contributing guide, issue templates, roadmap, and a provenance release workflow.

## 0.1.0 (2026-09-05)

First release: createGate, twelve checks in the LILA order, MemoryStore and RedisStore, commit-time atomic budget, fail-open or fail-closed on store errors, record/inspect, and the `replay` CLI.
