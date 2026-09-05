---
title: Spec and conformance
description: The behaviour contract both implementations are held to, and how to run it.
---

[`spec/SPEC.md`](https://github.com/Bubblegunn/proactive-gate/blob/main/spec/SPEC.md) states
numbered requirements (RFC 2119) for inputs, evaluation order, outcomes, shadow mode, time,
stores and budgets, policies and presets. `spec/SPEC_VERSION` is independent of the package
versions.

Fixtures under `spec/fixtures/<area>/<name>.json` carry a policy, an optional store seed, and
tests with an input and the expected decision fields: `allowed`, `trace`, `rejectedBy`,
`deferredBy`, `retryAt`, `deliverAt`, `surfaces`, `shadowed`, `nearLimit`, a `reason_pattern`,
and after `commit`, `store_after`. They cover the DST edge in America/New_York, Pacific/Apia,
a wall-clock case in 2031, atomic commit, the ISO week, deferral, shadow mode, the optional
checks and four presets.

An implementation conforms when it passes every fixture for its spec version, minus the names
in `spec/skip/<impl>.txt`, which must be empty at a stable release.

```
npm test                          # TypeScript: spec-lint, then one test per fixture
npx proactive-gate replay --fixtures spec/fixtures
cd python && pytest               # Python: every fixture through Gate and AsyncGate
```

Writing a second implementation? Start from the fixtures, not from the TypeScript source. The
reasons in the fixtures are matched by pattern, so wording may differ; the trace, the stopping
check and the store keys may not.
