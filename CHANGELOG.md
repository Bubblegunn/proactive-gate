# Changelog

## 0.2.3 (unreleased)

`dedupe`: one delivery per event per window, for transports that deliver at least once. A webhook resent because it did not get its `200` quickly enough, or the same event handed to two workers, produced two messages; `dedupe` claims `candidate.dedupeKey` atomically at commit with the increment the budgets use, so both attempts pass the check and exactly one commit wins. Off unless asked for, with `defaultChecks({ dedupe: true })` or a policy entry. Without a `dedupeKey` it skips rather than guessing an identity, because a deduplication keyed on something unique per attempt silently does nothing.

It consumes before the budgets, so a suppressed duplicate does not spend one of the user's messages for the day. The cost of that ordering is stated rather than hidden: an event that clears `dedupe` and is then refused by an exhausted budget has claimed its key for the rest of the window. The window is fixed from the first claim, not sliding.

The 24-hour default is the common retry horizon rather than a number of ours: Stripe prunes an idempotency key after 24 hours, and Nylas gives the same figure as the safe default for webhook deduplication. Both are linked from the README.

Spec 1.2.0 adds clauses 5.5 to 5.8 and two shared fixtures, so the Python package is held to the same behaviour rather than trusted; the race is a language-side test because a fixture cannot express concurrency. Verified by mutation: a read-then-write claim fails the race test in TypeScript and the fixtures in Python.

`dist/test/dedupe.test.js` was missing from the test script when it was written, so the seven new tests would not have run in CI. Added.

The Python gate now selects commit-time consumers by the presence of `consume_plan` rather than by a list of classes, matching the TypeScript side, so a new consumer is honoured without being registered in two places.

## 0.2.2 (2026-09-05)

Quiet hours can differ by day. A single window applies every day, which cannot express a working week that is not Monday to Friday: a Friday and Saturday weekend, a Friday evening to Saturday evening silence, and a public holiday all had to be written as a custom check. `quietHours` now takes a schedule as well as a window, resolving a date before a weekday before a default, where `null` at any level means the day has no quiet hours. A window still belongs to the day it opens on, so one that crosses midnight silences the next morning and the reason names the day it came from. The single-window form is unchanged and is still the default; a schedule whose every day resolves to the same window behaves identically to that window, asserted minute by minute in a zone with a 45-minute offset. Spec 1.1.0 adds clauses 6.4 to 6.7 and three fixtures, so the Python sibling is held to the same behaviour; breaking the carry in either implementation fails them.

There is no bundled holiday calendar and there will not be one: a caller supplies the dates it observes, because a bundled calendar goes stale without anyone noticing. What a schedule still cannot express is a window longer than 24 hours in one row; Friday evening to Saturday evening is two rows, and the README says so.

`publish-pypi` is skipped until the repository variable `PYPI_TRUSTED_PUBLISHER` is `true`. No trusted publisher exists on PyPI for this project, so the OIDC exchange returned `invalid-publisher` and every tagged release went red for a credential that cannot be created from CI. The job is gated rather than ignored: `build-python` still runs mypy strict, the tests, `python -m build` and `twine check` on every release, and the run prints what to configure at pypi.org and the `gh variable set` that turns publishing on. 0.2.1 is on PyPI, uploaded from a local build with a one-off token, since a trusted publisher cannot be configured for a project that does not exist. That release carries no build provenance and the Python documentation says so; the npm package's provenance is unaffected. CONTRIBUTING lists the three steps that move publishing into the workflow, in the order that keeps publishing possible throughout.

## 0.2.1 (2026-09-05)

The utility floor's threshold was attributed to "PRISM". No system of that name appears in Horvitz, Jacobs and Hovel, "Attention-Sensitive Alerting", UAI 1999, nor on Horvitz's publication index; the system in that paper is named Priorities. Corrected in the source, both READMEs, the documentation site and the generated API page. The mathematics is unchanged and is now stated directly: alerting costs `(1 - p) * cFA`, silence costs `p * cFN`, so the threshold is the classical Bayes decision boundary.

Every default now says whether it was measured or chosen. One was measured: `lambda = 1/43` comes from the field study in Achlioptas and Horvitz, "Principles of Bounded Deferral", 113 employees over three business days between 10am and 4pm, 4,803 busy situations, mean 43.12 s with a standard deviation of 51.79 s. The same paper's two-subject analysis gives 11 s for one person and 101 s for the other, so the spread between two people exceeds the default. `staleness` and `boundSeconds` are labelled as scale choices, since only their ratio reaches `t*`. The seven-day trust ramp and the three-in-thirty cooldown are labelled as ours, with no study behind them. The daily budget of five is ours in a direction Pielot and Rello support, citing a median of 63.5 notifications a day.

Two citations added: Okoshi, Tsubouchi and Tokuda (*Pervasive and Mobile Computing* 50:1-24, 2018), a Yahoo! JAPAN deployment of more than 680,000 users where deferring to an interruptible moment cut response time by 49.7 percent, as evidence for the direction only; and Pielot and Rello (MobileHCI 2017) as the counterweight, where a day without notifications left 15 of 30 participants afraid of missing something urgent and three approached recruits declining outright because their workplace expected them to be reachable. A gate that suppresses is not free and the README says so.

Two design limits documented and pinned by tests: the weekly budget uses the ISO week, so it refills on Monday, one day into a Sunday-to-Thursday working week; and quiet hours are a single window applied to every day, so a Friday, Shabbat or holiday rule cannot be expressed without a custom check.

No new preset. Canada's CASL and Australia's Spam Act carry no time-of-day rule; the Brazilian window comes from a bill, not a law, and covers telemarketing calls; and India's regulation makes time bands a preference the subscriber registers rather than a fixed statutory window, with secondary sources disagreeing about whether it starts at 09:00 or 10:00. The README now says that a regulatory preset binds a message only when the message is itself commercial.

## 0.2.0 (2026-09-05)

The optional checks now name their sources and their limits: the package ships no model, no cost and no probability, the rules come from Horvitz's attention-sensitive alerting and bounded deferral, and the field figure cited is Iqbal and Horvitz (CHI 2007), roughly 11 to 16 minutes to return to a suspended task. The widely repeated "23 minutes 15 seconds" is not from a peer-reviewed paper and is not used.

Property tests over the check order and the store contract, generated from a seeded PRNG rather than written case by case: the trace is always a prefix of the declared order with every check reporting once, a non-rejecting check cannot stop a decision however it misbehaves, racing deliveries commit exactly `min(racers, limit)` units, a replayed decision spends one, and `MemoryStore` and `SqliteStore` answer the same random operation sequence identically. Verified against a mutant: rewriting `consume` as read-then-write fails the race property.

`proactive-gate init` writes a readable policy with the ten default checks, appends a named preset before the budget, and prints that preset's sources next to the lines that wire the gate into AI SDK, Mastra, LangChain, OpenAI Agents or none of them. `--list` names the fourteen presets and the four frameworks, and the command refuses to overwrite an existing policy without `--force`. A test compiles the policy every preset produces.

`npm run bench:compare` replays a committed day of 21 candidates for 7 users through an honest hand-rolled policy of five `if` statements and through a gate built from the same fixture, and prints the six disagreements with the reason for each. `test/naive.test.mjs` pins the three shortcuts that policy takes: a fixed UTC offset sends half an hour into quiet hours the day New York leaves daylight time, a UTC-day budget key silences a Tokyo user for nine hours and pays a Los Angeles user twice, and a read-then-write counter lets two deliveries in flight both take the last slot while the counter still reads its limit afterwards.

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
