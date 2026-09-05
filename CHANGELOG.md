# Changelog

## 0.1.2 (2026-09-05)

- `SqliteStore` on `node:sqlite` (Node 22.5+), persistence for single-instance deployments, by @aaqib-hafeez-khan-in (#3).
- `weeklyBudget` check keyed on the user's local ISO week, consumed atomically at commit next to the daily one, `defaultChecks({ weeklyLimit })`, by @edwardsong08 (#9, closes #2).

A LangGraph example, a comparison with hand-rolled checks and feature flags, a benchmark (`npm run bench`) with the measured line in the README, and a generated API reference under `docs/api`.

## 0.1.1 (2026-09-05)

Mastra example, a real decision trace in the README, a "Writing your own check" section with a test, Turkish README, contributing guide, issue templates, roadmap, and a provenance release workflow.

## 0.1.0 (2026-09-05)

First release: createGate, twelve checks in the LILA order, MemoryStore and RedisStore, commit-time atomic budget, fail-open or fail-closed on store errors, record/inspect, and the `replay` CLI.
