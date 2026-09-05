# Claiming conformance

This directory is the contract. `SPEC.md` states the behaviour as numbered requirements and
`fixtures/` holds the cases that decide whether an implementation meets them. Both are
language-neutral: an implementation in any language can run them, and none of it depends on the
npm or PyPI packages.

## Getting the suite

The suite is versioned by `SPEC_VERSION`, and each version is tagged `spec/vX.Y.Z`, a series
separate from the package's own `vX.Y.Z` release tags.

```sh
git clone --depth 1 --branch spec/v1.2.0 https://github.com/Bubblegunn/proactive-gate
# or, to keep it beside your own source and update it deliberately
git subtree add --prefix spec https://github.com/Bubblegunn/proactive-gate spec/v1.2.0 --squash
```

A JavaScript implementation can also read the fixtures from an install, because the npm package
ships this directory: `node_modules/proactive-gate/spec/fixtures`. The Python wheel does not ship
it; use git there.

## What passing means

An implementation conforms at version X when, for every fixture whose `spec_version` is X, every
assertion in every test's `expect` holds.

A fixture is a JSON document described by `schema/fixture.schema.json`. For each test, evaluate the
policy against the input at the given `now` and compare:

| Field | Comparison |
|---|---|
| `allowed` | exact |
| `trace` | exact, the ordered list of check ids that ran |
| `rejectedBy`, `deferredBy` | exact, including absent |
| `retryAt`, `deliverAt` | exact, as an ISO instant ending `Z` |
| `surfaces`, `shadowed`, `nearLimit` | exact, when the fixture asserts them |
| `reason_pattern` | a regular expression that must match the decision's reason |
| `commit` | the boolean returned by committing the decision, when the test sets `commit` |
| `store_after` | exact, each key read from the store after the test, with the policy's key prefix |

`ms` on a trace entry is informative and is never asserted (`SPEC.md` 8.1). A fixture's
`store_seed` is written to the store before the tests run, with the same prefix.

Both existing runners work exactly this way, so this table describes the suite rather than adding a
second rule to it: see `src/conformance.ts` and `python/src/proactive_gate/conformance.py`.

## Declaring what you skip

Silence about a failing fixture is the one thing that makes a conformance claim worthless. Declare
skips in `skip/<impl>.txt`, one fixture name per line, with the reason after a `#`:

```
quiet-hours/apia   # no IANA time zone database on this platform
```

`SPEC.md` requires that file to be empty at a stable release. Before then, the honest form of a
partial claim is "conforms to 1.2.0 except these fixtures, for these reasons", stated where a
reader will see it.

## Declaring the version you target

State the spec version in your own metadata, and assert in your continuous integration that it
equals the `SPEC_VERSION` in the suite you vendored. Both implementations here do that, and it is
what stops a suite from being updated underneath a claim.

## Adding to the suite

A fixture is a contract for every implementation, not only this one. So a change lands in
`SPEC.md`, in `fixtures/`, and in both implementations, or it does not land. New fixtures carry
`since` set to the version that introduced them, and `spec_version` set to the current one, which
`test/spec-lint.mjs` checks.

Versioning follows `SPEC.md`: a patch adds fixtures existing implementations already pass, a minor
adds a check or a field, a major changes an expectation.

## The honest status of this suite

Two implementations pass it, and the same person wrote both within hours of each other. That is
weaker evidence than it looks: agreement between two implementations by one author is closer to a
consistency check than to independent verification. A third implementation, written from `SPEC.md`
by someone who has not read the source, is what would test whether this document is enough. Until
that exists, treat the suite as a contract that has been used twice, not as a proven standard.
