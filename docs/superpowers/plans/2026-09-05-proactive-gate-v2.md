# proactive-gate v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the v2 design: a conformance spec with fixtures, JSON policies, the defer/shadow/hooks outcome model, two optional caller-fed checks, sourced presets, adapters and a Claude Code hook, a Python implementation held to the same fixtures, and a docs site with a playground.

**Architecture:** The TypeScript package stays at the repo root and remains the reference implementation. `spec/` holds the language-neutral contract and fixtures both implementations run. Policies are JSON compiled to `GateOptions` by `compilePolicy`. New checks compose the same `Check` interface. Python mirrors the behaviour through a sans-IO core (checks declare keys, then judge pure values) so one `decide()` serves sync and async gates.

**Tech Stack:** TypeScript 7 (NodeNext, node:test), Python 3.11+ (hatchling, pytest, mypy), Astro Starlight + esbuild for the docs site, GitHub Actions (SHA-pinned), npm and PyPI trusted publishing.

**Spec:** `docs/superpowers/specs/2026-09-05-proactive-gate-v2-design.md`

## Global Constraints

- Zero runtime dependencies in the npm package; site tooling lives in `docs/site/package.json`.
- No em dashes anywhere; README must pass `node /Users/efe/Desktop/ai-slop-linter/dist/src/cli.js README.md`.
- Commit format: conventional title, technical body, `Sade dil (teknik olmayan biri için):` block, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- `git pull --rebase origin main` before every push; wait for `ci`, `zizmor`, `scorecard`.
- Every new action pinned to a SHA with a version comment; `uvx zizmor .github/workflows` clean before pushing workflow changes.
- `spec/SPEC_VERSION` is `1.0.0`; `spec_version` in every fixture equals it.
- Python `requires-python = ">=3.11"`, no runtime dependencies, optional extra `redis`.
- Do not tag, publish, or post externally.

---

## File structure

| Path | Responsibility |
|---|---|
| `spec/SPEC.md`, `spec/SPEC_VERSION`, `spec/schema/*.json`, `spec/fixtures/**`, `spec/skip/*.txt` | The contract and its fixtures |
| `test/spec-lint.mjs` | Structural validation of fixtures and example policies (no deps) |
| `test/conformance.test.ts` | Runs fixtures against the TS gate |
| `src/conformance.ts` | Fixture loader and runner shared by the test and the CLI `--fixtures` |
| `src/types.ts` | New outcome kinds, decision fields, user and candidate fields, hooks |
| `src/gate.ts` | defer, shadow, nearLimit, hooks, idempotent commit |
| `src/checks.ts` | `nearLimit` on budgets, `monthlyBudget`, `utilityFloor`, `boundedDeferral`, primitives (`allowedWindow`, `requiresConsent`, `rateLimit`, `recentInteraction`, `windowBudget`) |
| `src/policy.ts` | `Policy` type, `compilePolicy`, `KNOWN_CHECKS` |
| `src/presets.ts` | The fourteen presets |
| `src/adapters/{ai-sdk,mastra,langchain,openai-agents}.ts` | Subpath exports |
| `src/cli.ts` | `replay --fixtures`, JSON policies, `hook` subcommand |
| `src/stores.ts` | `SqliteStore` resolves `node:sqlite` lazily |
| `examples/policy.json`, `examples/otel.ts`, `examples/vercel-ai-sdk.ts`, `examples/claude-code-hook.json` | Usage |
| `python/**` | The Python package |
| `docs/site/**` | Starlight site and playground |
| `.github/workflows/{ci,release,pages}.yml` | spec-lint and python jobs, PyPI publish, Pages deploy |

---

### Task 1: Spec text, version, schemas, spec-lint

**Files:** Create `spec/SPEC.md`, `spec/SPEC_VERSION`, `spec/schema/fixture.schema.json`, `spec/schema/policy.schema.json`, `spec/skip/ts.txt`, `spec/skip/python.txt`, `test/spec-lint.mjs`. Modify `package.json` scripts (`"spec-lint": "node test/spec-lint.mjs"`), `.github/workflows/ci.yml` (job `spec-lint`, added to `ci-ok` needs).

**Interfaces:** Produces the fixture file shape from spec section 3 and the policy shape from section 4. `test/spec-lint.mjs` exits non-zero on the first invalid file and prints `path: message`.

- [x] Write `spec/SPEC.md` with numbered requirements (sections 1 to 8 from the spec).
- [x] Write both JSON Schemas (draft 2020-12, `additionalProperties: false` on fixture and test objects; policy entries allow extra option keys).
- [x] Write `test/spec-lint.mjs`: walks `spec/fixtures/**/*.json` and `examples/*.json`, validates required keys, types, enums (`outcome` kinds, priorities), `spec_version === SPEC_VERSION`, `trace` is an array of strings, `now` ends with `Z`. Print `ok N fixtures, M policies`.
- [x] Run `node test/spec-lint.mjs` (expects `ok 0 fixtures` until Task 2).
- [x] Add the CI job and commit: `feat(spec): behaviour contract, fixture and policy schemas, spec-lint`.

### Task 2: Fixtures and the TypeScript conformance runner

**Files:** Create `src/conformance.ts`, `test/conformance.test.ts`, fixtures under `spec/fixtures/{ordering,consent,mode,quiet-hours,trust-ramp,cooldown,budget,adaptive-timing}/`. Modify `src/cli.ts` (`--fixtures`), `package.json` test script (add `dist/test/conformance.test.js`).

**Interfaces:**
```ts
export interface Fixture { spec_version: string; since: string; name: string; description: string; policy: Policy; store_seed?: Record<string,string>; tests: FixtureTest[] }
export interface FixtureTest { description: string; input: { user: UserState; candidate: Candidate; now: string }; commit?: boolean; expect: Expect }
export interface Expect { allowed: boolean; rejectedBy?: string; deferredBy?: string; retryAt?: string; surfaces?: string[]; deliverAt?: string; trace: string[]; shadowed?: string[]; reason_pattern?: string; commit?: boolean; store_after?: Record<string,string> }
export async function loadFixtures(dir: string): Promise<Fixture[]>
export async function runFixture(fixture: Fixture, make: (policy: Policy, store: Store) => Gate): Promise<{ name: string; failures: string[] }>
export async function readSkips(file: string): Promise<Set<string>>
```
The runner seeds a `MemoryStore` through the gate's key prefix (seed keys are prefixed with the policy's `keyPrefix ?? "pg:"`), runs tests in order, compares normative fields, and reads `store_after` back through the same prefix.

- [x] Write `test/conformance.test.ts`: one `test()` per fixture, `t.skip` for names in `spec/skip/ts.txt`, `assert.deepEqual(failures, [])`.
- [x] Write the first fixtures (ordering short-circuit, consent, mode, quiet hours incl. `America/New_York` 2026-03-08 and `Pacific/Apia`, the wall-clock fixture in 2031, trust ramp, cooldown with seeded stamps, daily and weekly budget with `commit` and `store_after`, adaptive timing placeholder).
- [x] Implement `src/conformance.ts` and `compilePolicy` stub usage (Task 3 provides the real one; until then the runner uses `defaultChecks` for `{ preset }`-free policies by mapping ids through a temporary table that Task 3 replaces).
- [x] `npm test` green, `node test/spec-lint.mjs` green; commit `feat(spec): fixtures and the TypeScript conformance runner`.

### Task 3: Policy as data

**Files:** Create `src/policy.ts`, `examples/policy.json`. Modify `src/gate.ts` (`createGate({ policy })`), `src/index.ts` (export `compilePolicy`, `Policy`, `PolicyEntry`), `src/cli.ts` (`loadPolicy` accepts `.json`), `test/gate.test.ts` (policy tests), `README.md` section.

**Interfaces:**
```ts
export interface Policy { specVersion: string; onStoreError?: "open" | "closed"; keyPrefix?: string; checks: PolicyEntry[] }
export type PolicyEntry = ({ id: string; shadow?: boolean } & Record<string, unknown>) | { preset: string; shadow?: boolean; [k: string]: unknown }
export const KNOWN_CHECKS: Record<string, (options: Record<string, unknown>) => Check>
export function compilePolicy(policy: Policy): GateOptions
```
`createGate` accepts `GateOptions | { policy: Policy; store?: Store; onDecision?; hooks? }`.

- [x] Tests: compiles the example policy to thirteen checks in order; unknown id throws naming known ids; `{ preset: "usTcpa" }` expands (after Task 6, until then the test uses a registered test preset); `specVersion` "2.0.0" throws; `shadow: true` sets `check.shadow`.
- [x] Implement, make `examples/policy.json` mirror `examples/policy.js` minus functions; `npm run examples` also runs the JSON policy.
- [x] Commit `feat(policy): JSON policies compiled by compilePolicy and accepted by createGate and the CLI`.

### Task 4: Outcome model

**Files:** Modify `src/types.ts`, `src/gate.ts`, `src/checks.ts` (nearLimit on daily/weekly/monthly budgets), `test/gate.test.ts`, fixtures `spec/fixtures/{shadow,defer,budget}/`, `examples/otel.ts`, `README.md`.

**Interfaces:** per spec section 5:
```ts
type CheckOutcome = { kind: "pass"; reason?: string; nearLimit?: { used: number; limit: number } } | { kind: "reject"; reason: string } | { kind: "adjust"; ... } | { kind: "skip"; reason: string } | { kind: "defer"; reason: string; retryAt: Date }
interface Check { id; nonRejecting?; shadow?; run }
interface TraceEntry { id; outcome; reason?; ms; shadow?: boolean }
interface Decision { id: string; allowed; deferredBy?; retryAt?; shadowed: string[]; nearLimit: { check: string; used: number; limit: number }[]; ... }
interface GateHooks { before?(ctx: CheckContext, check: Check): void | Promise<void>; after?(ctx, check, outcome: CheckOutcome, ms: number): void | Promise<void>; error?(ctx, check, error: unknown): void | Promise<void>; finally?(decision: Decision): void | Promise<void> }
```
`decision.id = \`${userId}:${candidateId}:${evaluatedAt.toISOString()}\``; `commit` stores `commit:<id>` = "1"/"0" with 2-day TTL and returns the stored result on repeat.

- [x] Tests: defer decision (`allowed false`, `deferredBy`, `retryAt`); shadow reject continues and lists `shadowed`; nearLimit appears at 4 of 5; hooks called in order with ms; a throwing hook does not change the decision; commit twice consumes once; commit on deferred returns false; replay summary counts deferred.
- [x] Fixtures: `shadow/reject-continues.json`, `defer/snooze-as-defer.json` (a JSON policy entry `{ "id": "snooze", "defer": true }` makes snooze defer with `retryAt = snoozedUntil`), `budget/near-limit.json`.
- [x] Implement; write `examples/otel.ts` with a local `Tracer { startSpan(name): { setAttribute, end } }` interface.
- [x] Commit `feat(gate): defer, shadow mode, near-limit counters, hooks, idempotent commit`.

### Task 5: Optional checks

**Files:** Modify `src/checks.ts`, `src/types.ts` (`Candidate.pAccept`, `pNeed`, `busy`), `src/policy.ts` (register), `test/gate.test.ts`, fixtures `spec/fixtures/utility/`, `README.md`.

**Interfaces:**
```ts
export function utilityFloor(o: { costFalseAlarm: number; costMissedHelp: number }): Check   // id "utilityFloor"
export function boundedDeferral(o?: { lambda?: number; interruptCost?: number; staleness?: number; boundSeconds?: number; isBusy?: (ctx: CheckContext) => boolean }): Check  // id "boundedDeferral", nonRejecting
```
tau = cFA / (cFA + pNeed * cFN); t* = min(bound, lambda * c / (2 * staleness)).

- [x] Tests: pAccept 0.41 with cFA 1, cFN 2, pNeed 0.4 gives tau 0.5556 and rejects with reason `pAccept 0.41 < tau 0.556`; pAccept 0.6 passes; missing pAccept skips; busy candidate gets deliverAt now + t*; not busy passes; defaults produce t* = 240 capped.
- [x] Fixtures `utility/floor.json`, `utility/bounded-deferral.json`.
- [x] Commit `feat(checks): optional utilityFloor and boundedDeferral, caller-fed`.

### Task 6: Primitives and presets

**Files:** Create `src/presets.ts`, `test/presets.test.ts`, fixtures `spec/fixtures/presets/`. Modify `src/checks.ts` (primitives), `src/types.ts` (`UserState.consents`, `lastInboundAt`, `minor`, `existingCustomer`; `Candidate.channel`), `src/policy.ts` (register primitives and presets), `package.json` exports (`"./presets"`), `README.md` presets table.

**Interfaces:**
```ts
export function allowedWindow(o: { start: string; end: string; timezone: string | "user"; priorityFloor?: Priority; id?: string }): Check
export function requiresConsent(o: { name: string; when?: { start: string; end: string; timezone: string | "user" }; id?: string }): Check
export function monthlyBudget(o?: { limit?: number; bypassPriority?: Priority; nearLimit?: number }): BudgetCheck
export function rateLimit(o: { limit: number; perSeconds: number; keyBy?: "user" | "channel"; id?: string }): Check
export function recentInteraction(o: { withinHours: number }): Check
export function windowBudget(o: { limit: number; withinHours: number }): BudgetCheck-like (consumed at commit)
export interface Preset { (options?: Record<string, unknown>): Check[]; sources: string[]; note: string }
export const presets: Record<string, Preset>   // lineMessagingApi, wechatSubscriptionMessage, ... slackApp
```
`rateLimit` and `windowBudget` consume at commit like the budgets: `gate.ts` treats any check with a `consume(ctx): Promise<boolean>` method as a budget and calls it in order.

- [x] Tests per preset: the check ids in order, the source list is non-empty, one allow and one reject case each (e.g. usTcpa rejects at 21:30 America/Chicago; kakaoBrandMessage rejects 21:00 Asia/Seoul; krNetworkAct50 rejects 23:00 without `night` consent and passes with it; cnMinorMode rejects 23:00 for a minor and passes for an adult).
- [x] Fixtures for four presets.
- [x] Commit `feat(presets): fourteen platform and regulatory presets with sources`.

### Task 7: Adapters and the hook

**Files:** Create `src/adapters/{ai-sdk,mastra,langchain,openai-agents}.ts`, `test/adapters.test.ts`, `examples/claude-code-hook.json`. Modify `package.json` exports, `src/cli.ts` (`hook`), `examples/vercel-ai-sdk.ts` (rewrite), `scripts/smoke-tarball.sh` (import a subpath), `README.md`.

**Interfaces:** per spec section 8. `toInput` is `(x) => EvaluateInput`.

- [x] Tests: each adapter denies with the gate's reason and allows otherwise; hook prints the PreToolUse JSON for a matching tool and nothing for others (spawn `dist/src/cli.js hook --policy examples/policy.json` with stdin).
- [x] Commit `feat(adapters): ai-sdk, mastra, langchain, openai-agents subpaths and a Claude Code PreToolUse hook`.

### Task 8: Python sibling

**Files:** Create `python/pyproject.toml`, `python/README.md`, `python/src/proactive_gate/{__init__,types,clock,checks,gate,stores,policy,presets,conformance,py.typed}.py`, `python/tests/{test_conformance,test_stores,test_clock}.py`. Modify `.github/workflows/ci.yml` (job `python`), `.github/workflows/release.yml` (build and publish jobs), `README.md` Python section.

**Interfaces:**
```python
class Check(Protocol):
    id: str; non_rejecting: bool; shadow: bool
    def keys(self, ctx: Context) -> Sequence[str]: ...
    def run(self, ctx: Context, values: Mapping[str, str | None]) -> Outcome: ...
def decide(checks, input, values_by_check, hooks) -> Decision   # pure
class Gate:  evaluate(input) -> Decision; commit(decision, input) -> bool; record(...); inspect(...)
class AsyncGate: same, async
def compile_policy(policy: Mapping[str, Any]) -> list[Check]
```
- [x] Conformance test parametrised over `../spec/fixtures/**/*.json`, skips from `spec/skip/python.txt`.
- [x] Implement until conformance is green; mypy strict clean.
- [x] Commit `feat(python): proactive-gate for Python, same fixtures, sync and async gates`.

### Task 9: Docs site and Pages

**Files:** Create `docs/site/{package.json,astro.config.mjs,src/content/docs/*.md,src/pages/playground.astro,scripts/bundle.mjs}`, `.github/workflows/pages.yml`. Modify `src/stores.ts` (lazy `node:sqlite`), `README.md` (site link), `llms.txt`.

- [x] `scripts/bundle.mjs` runs esbuild on `../../src/index.ts` (platform browser, format esm, external `node:*`) into `public/playground/gate.js`.
- [x] Playground page: two textareas (policy JSON, input JSON), a Run button, trace table, first reject highlighted.
- [x] Local `npm run build` in `docs/site` passes; Pages workflow SHA-pinned and zizmor clean.
- [x] Commit `docs(site): Starlight docs with a browser playground`.

### Task 10: Documentation sweep

- [x] README sections (policy, outcome model, optional checks, presets, adapters, Python, spec, site, lineage paragraph); README.tr.md; llms.txt; docs/api regenerated with `npx typedoc` if available; CHANGELOG `## 0.2.0 (unreleased)`.
- [x] ai-slop-linter pass on README.
- [x] Commit `docs: v2 sections`.

## Self-review

Spec coverage: sections 3 (Task 1, 2), 4 (Task 3), 5 (Task 4), 6 (Task 5), 7 (Task 6), 8 (Task 7), 9 (Task 8), 10 (Task 9), 11 and 12 (Task 10 plus the CI jobs in Tasks 1, 8, 9). No placeholders remain; every interface named in a later task is defined in an earlier one (`compilePolicy` Task 3 used by Task 2's runner through the temporary table, replaced in Task 3).
