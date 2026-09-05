# proactive-gate v2 design (spec, policy as data, outcome model, presets, adapters, Python sibling, docs site)


> Corrected 2026-09-05: this document originally named the threshold "PRISM". The system in
> Horvitz, Jacobs and Hovel, *Attention-Sensitive Alerting*, UAI 1999 is named **Priorities**;
> no system called PRISM appears in that paper. The mathematics was and remains correct.


Date: 2026-09-05. Status: approved by the maintainer in conversation; this file is the written form.
Source of the priorities: the 2026-09-05 research report (Horvitz's alerting formulas, platform and
regulatory presets, adapter surfaces, conformance-suite precedents in OpenFeature, Unleash, JSON Schema).

## 1. Goal

Turn proactive-gate from a single TypeScript library into a small standard: a language-neutral
behaviour contract with fixtures, a JSON policy format, a richer outcome model, presets for the
platform and legal limits people actually ship against, adapters on the surfaces where agents
send messages, a Python implementation held to the same fixtures, and a docs site whose
playground is the replay CLI in the browser. The npm package keeps zero runtime dependencies.

## 2. Repository layout

```
/                      TypeScript package (unchanged root; npm publishes from here)
  src/                 core, checks, stores, policy, presets, adapters/, cli
  test/                node:test suites incl. conformance.test.ts
  examples/            policy.json, policy.js, otel.ts, adapters usage, day.jsonl
spec/                  the behaviour contract (section 3)
python/                the Python package (section 9)
docs/site/             Starlight docs site with the playground (section 10)
docs/superpowers/      specs and plans
```

## 3. Conformance spec (`spec/`)

- `spec/SPEC.md`: numbered requirements using RFC 2119 words. Sections: 1 Inputs, 2 Evaluation
  order and short circuit, 3 Outcomes (pass, reject, adjust, skip, defer), 4 Shadow mode,
  5 Store keys and atomic commit, 6 Clock and time zones, 7 Policy document, 8 Trace.
  Examples: "2.1 An implementation MUST run checks in policy order and MUST stop at the first
  rejecting check that is not in shadow mode." "6.2 A check MUST NOT read a wall clock; `now`
  is input."
- `spec/SPEC_VERSION`: semver of the contract, starting at `1.0.0`, independent of package
  versions. Patch: new fixtures existing implementations pass. Minor: new check or field with
  `since`. Major: changed expectations.
- `spec/schema/fixture.schema.json` and `spec/schema/policy.schema.json` (JSON Schema draft
  2020-12). A `spec-lint` CI job validates every fixture and every example policy against them
  with a zero-dependency validator shipped in `test/spec-lint.mjs` (structural checks only:
  required fields, types, enums, unknown keys).
- `spec/fixtures/<area>/<name>.json`, areas: `ordering`, `consent`, `mode`, `quiet-hours`,
  `trust-ramp`, `cooldown`, `budget`, `adaptive-timing`, `shadow`, `defer`, `policy`,
  `utility`, `presets`. Shape:

```json
{
  "spec_version": "1.0.0",
  "since": "1.0.0",
  "name": "budget/daily-atomic-commit",
  "description": "evaluate reads, commit consumes, the sixth commit is refused",
  "policy": { "specVersion": "1.0.0", "checks": [ { "id": "consent" }, { "id": "dailyBudget", "limit": 2 } ] },
  "store_seed": { "budget:u1:2026-09-04": "1" },
  "tests": [
    {
      "description": "one left",
      "input": { "user": { "id": "u1", "consent": true, "timezone": "Europe/Istanbul" },
                 "candidate": { "id": "c1", "type": "reminder" }, "now": "2026-09-04T09:00:00Z" },
      "commit": true,
      "expect": { "allowed": true, "surfaces": ["feed"], "trace": ["consent", "dailyBudget"],
                  "commit": true, "store_after": { "budget:u1:2026-09-04": "2" } }
    }
  ]
}
```

  Normative expectations: `allowed`, `rejectedBy`, `deferredBy`, `retryAt`, `surfaces`,
  `deliverAt` (ISO instant), `trace` (ordered check ids; it is the short-circuit rule),
  `shadowed` (ids that would have rejected), `commit`, `store_after` (keys without the
  implementation's prefix). Informative: `reason_pattern` (regex an implementation MAY match).
  Never `ms`. Tests inside one fixture run in order and share the seeded store. `now` is always
  UTC with `Z`; the IANA zone is input data. Required fixtures: DST edges in `America/New_York`
  (2026-03-08) and `Pacific/Apia`, and a "wall clock" fixture whose `now` is in 2031 and whose
  quiet-hours outcome only holds if `now` was honoured.
- `spec/skip/ts.txt`, `spec/skip/python.txt`: one `fixture-name  # reason` per line; both empty
  at a stable release. The conformance runners honour them and print skipped names.
- The replay CLI accepts `--fixtures <dir>` and runs the suite for the TypeScript package, so a
  future implementation in another language can be checked by shelling out to its own CLI with
  the same flag.

## 4. Policy as data

- `policy.schema.json` shape: `{ specVersion, onStoreError?, keyPrefix?, checks: Entry[] }`,
  `Entry = { id, shadow?, ...options }` or `{ preset, shadow? }` which expands to the preset's
  ordered checks. Ids and options mirror the constructors: `killSwitch { on }`, `consent`,
  `enabled`, `mode { allow }`, `snooze`, `mute`, `intensity { floors? }`, `quietHours
  { priorityFloor? }`, `trustRamp { days?, minPriority? }`, `dismissalCooldown { dismissals?,
  withinDays?, silenceDays? }`, `adaptiveTiming` (no options; a JSON policy cannot carry a
  function, so it is a no-op placeholder that keeps the trace shape), `dailyBudget`,
  `weeklyBudget`, `monthlyBudget { limit?, bypassPriority?, nearLimit? }`, `utilityFloor`,
  `boundedDeferral`, `allowedWindow`, `requiresConsent`, `rateLimit`, `recentInteraction`.
- `compilePolicy(policy: Policy): GateOptions` and `createGate({ policy })` (policy and checks
  are mutually exclusive; passing both throws). Unknown check id throws with the list of known
  ids. `specVersion` must satisfy the package's supported major.
- `loadPolicy(path)` in the CLI accepts `.json` (compiled) or `.js`/`.mjs` (module exporting a
  gate) and the replay CLI gains `--fixtures`.

## 5. Outcome model

- `CheckOutcome` gains `{ kind: "defer"; reason; retryAt: Date }` and `pass` gains optional
  `reason` and `nearLimit?: { used, limit }`.
- `Decision` gains `id` (stable: `sha1`-free string `${userId}:${candidateId}:${evaluatedAt ISO}`),
  `deferredBy?`, `retryAt?`, `shadowed: string[]`, `nearLimit: Array<{ check, used, limit }>`.
  `allowed` stays a boolean and is false for defer and reject.
- `Check.shadow?: boolean`: a rejecting or deferring outcome is recorded (trace entry keeps
  `outcome: "reject"` and gains `shadow: true`), the id is appended to `shadowed`, evaluation
  continues. Policy entries accept `shadow: true`.
- Budget checks accept `nearLimit` (fraction of the limit, default 0.8); when `used >= ceil(limit
  * nearLimit)` the pass outcome carries `nearLimit: { used, limit }` and the decision lists it.
- `GateOptions.hooks?: { before?(ctx, check), after?(ctx, check, outcome, ms), error?(ctx,
  check, error), finally?(decision) }`. Hooks never change the decision; a throwing hook is
  reported through `error` and otherwise ignored. `examples/otel.ts` emits one span per check
  through a minimal local tracer interface.
- `commit(decision, input)` is idempotent on `decision.id`: the result is stored under
  `commit:<id>` with a 2-day TTL and returned unchanged on a second call, so a resumed graph
  node cannot spend the budget twice. `commit` returns false for deferred decisions.

## 6. Optional caller-fed checks (off by default, not in `defaultChecks`)

- `utilityFloor({ costFalseAlarm, costMissedHelp })`. Reads `candidate.pAccept` and
  `candidate.pNeed` (new optional numeric fields). Threshold from the expected-utility rule:
  `tau = costFalseAlarm / (costFalseAlarm + pNeed * costMissedHelp)`. Rejects when
  `pAccept < tau` with reason `pAccept 0.41 < tau 0.55`. Skips when `pAccept` is missing.
  `pNeed` defaults to 1. The package ships no model; both probabilities come from the caller.
- `boundedDeferral({ lambda, interruptCost, staleness, boundSeconds })`. Non-rejecting. When
  `candidate.busy === true` (or the caller's `isBusy(ctx)` returns true) it sets `deliverAt =
  now + t*` with `t* = min(boundSeconds, lambda * interruptCost / (2 * staleness))`, the optimum
  of quadratic staleness loss `f(t) = staleness * t^2` against interrupt cost `interruptCost`
  and free-by-t probability `1 - e^(-lambda t)` (Horvitz bounded deferral: `f'(t*) = lambda *
  c`). Defaults: lambda 1/43 per second (mean busy episode 43 s), interruptCost 1, staleness
  0.0001, bound 240 s.

## 7. Presets (`proactive-gate/presets`)

Each preset is a function returning an ordered `Check[]` and carries `sources: string[]` and a
`note`. Doc comment and README say: reviewable defaults, not legal advice; every number sits
next to its source. New primitives they compose: `allowedWindow({ start, end, timezone: IANA |
"user", priorityFloor?, id? })`, `requiresConsent({ name, when?: { start, end, timezone } })`
reading `user.consents?.[name]`, `monthlyBudget`, `rateLimit({ limit, perSeconds, keyBy: "user"
| "channel" })` reading `candidate.channel`, `recentInteraction({ withinHours })` reading
`user.lastInboundAt`, `windowBudget({ limit, withinHours })` keyed on `lastInboundAt`.

| Preset | Encodes |
|---|---|
| `lineMessagingApi({ plan })` | monthly push budget 200 / 5,000 / 30,000 by plan (communication, light, standard); consent |
| `wechatSubscriptionMessage()` | consent named `subscription`, `windowBudget` 1 per opt-in window |
| `wechatCustomerService()` | inbound within 48 h, at most 5 in that window |
| `wechatTemplateMessage()` | consent named `templateTrigger`, per-type rate limit 3 per day |
| `wecomAppMessage()` | 30 per minute and 1,000 per hour per member |
| `kakaoAlimtalk()` | consent; no time window |
| `kakaoBrandMessage()` | consent named `ad`; window 08:00 to 20:50 Asia/Seoul |
| `krNetworkAct50()` | consent named `ad`; 21:00 to 08:00 needs consent `night` |
| `jpAntiSpamLaw()` | consent named `optIn`; no time rule (documented) |
| `cnMinorMode()` | when `user.minor` is true: window 06:00 to 22:00 Asia/Shanghai, daily budget 1 |
| `usTcpa()` | window 08:00 to 21:00 in the user's zone |
| `euEprivacy()` | consent named `marketing` unless `user.existingCustomer` (soft opt-in) |
| `telegramBot()` | rate 1 per second per channel, 20 per minute per channel |
| `slackApp()` | rate 1 per second per channel |

`user` gains optional `consents`, `lastInboundAt`, `minor`, `existingCustomer`; `candidate`
gains optional `channel`, `busy`, `pAccept`, `pNeed`.

## 8. Adapters and the hook

Subpath exports, each typed against a minimal local interface so nothing is installed to build:

- `proactive-gate/ai-sdk`: `gateToolApproval({ gate, toInput })` returns
  `(call) => Promise<{ approved: boolean; reason?: string }>` for AI SDK tool approvals.
- `proactive-gate/mastra`: `gateProcessor({ gate, toInput })` returns a processor with
  `processOutputResult({ messages, abort })` that calls `abort(reason)` on reject.
- `proactive-gate/langchain`: `gateMiddleware({ gate, toInput, tools })` returns
  `{ name, wrapToolCall(request, handler) }` that returns a tool message with the reason instead
  of calling the handler when rejected.
- `proactive-gate/openai-agents`: `gateToolInputGuardrail({ gate, toInput })` returns
  `{ name, execute }` producing `{ tripwireTriggered, outputInfo }`.
- CLI `proactive-gate hook --policy <file> [--tool <name>]`: reads Claude Code PreToolUse JSON
  on stdin; when `tool_name` matches (default `send_message`) it reads `tool_input.gate`
  (`{ user, candidate, now? }`) and prints
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"|"deny",
  "permissionDecisionReason":"..."}}`; deferred decisions print `deny` with the retry instant in
  the reason. Other tools print nothing and exit 0.
- `examples/vercel-ai-sdk.ts` is rewritten around tool approvals; the model-middleware version
  is deleted.

## 9. Python sibling (`python/`)

- `pyproject.toml` with hatchling, name `proactive-gate`, import name `proactive_gate`,
  `requires-python = ">=3.11"`, no runtime dependencies, optional extra `redis`.
- Sans-IO core: a check exposes `id`, `non_rejecting`, `shadow`, `keys(ctx) -> Sequence[str]`
  (store keys it needs) and `run(ctx, values: Mapping[str, str | None]) -> Outcome`, a pure
  function. `Gate` (sync, `Store` Protocol) and `AsyncGate` (`AsyncStore` Protocol) both call the
  same `decide()` after fetching the keys, so the decision logic exists once.
- Stores: `MemoryStore`, `SqliteStore` (stdlib sqlite3), `RedisStore` (redis.asyncio, INCR then
  EXPIRE on first increment), `AsyncMemoryStore`.
- Frozen slotted dataclasses for `UserState`, `Candidate`, `Decision`, `TraceEntry`; `Priority`
  and outcomes as `Literal`s; `py.typed`; mypy strict and pyright clean.
- `load_policy(dict)` compiles the same JSON policy; presets mirrored one to one.
- `tests/test_conformance.py` parametrised over `../spec/fixtures/**/*.json` honouring
  `spec/skip/python.txt`; unit tests for stores and the clock.
- CI job `python` (ubuntu, 3.11 and 3.13): `pip install -e .[dev]`, `mypy --strict`, `pytest`.
- Release: `release.yml` gains `build-python` (builds `python/dist` with `python -m build`,
  uploads the artifact) and `publish-pypi` (separate job, `environment: pypi`, `id-token:
  write`, SHA-pinned `pypa/gh-action-pypi-publish`). Efe creates the PyPI trusted publisher
  (owner Bubblegunn, repo proactive-gate, workflow `release.yml`, environment `pypi`).

## 10. Docs site (`docs/site/`)

Starlight with its own `package.json`. Pages: Start, Decisions, Checks, Policy, Presets,
Adapters, Python, Spec, Playground. The playground loads an esbuild browser bundle of the
TypeScript package (built by the site's build script from `../../src/index.ts`, `platform:
browser`, `node:*` external; `SqliteStore` resolves `node:sqlite` lazily through
`process.getBuiltinModule` so the module loads in a browser) and shows policy JSON on the left,
the input on the right, and the trace table below with the first rejecting check highlighted.
`llms.txt` is served through `starlight-llms-txt`. A Pages workflow (SHA-pinned actions,
`permissions: pages: write, id-token: write` on the deploy job only) builds on push to main
when `docs/site/**`, `src/**` or `README.md` change.

## 11. README and docs updates

New sections: policy as data, shadow mode and hooks, defer, optional checks with the two
formulas, presets table with sources, adapters, Python, spec and conformance, docs site link, a
lineage paragraph (Matrix push rules, Android notification channels, iOS interruption levels).
`README.tr.md`, `llms.txt`, `docs/api` and `CHANGELOG.md` (`## 0.2.0 (unreleased)`) follow.

## 12. Testing

node:test for every new unit; the conformance suite for both languages; `spec-lint`; the
existing bench must still run; `publint`, `attw` and the tarball smoke test must pass with the
new subpath exports; the README passes ai-slop-linter.

## 13. Out of scope

A utility score replacing the order; a shipped timing model; a hosted service; Dify plugin; a
PostgresStore; digest helpers; regulatory presets presented as compliance.
