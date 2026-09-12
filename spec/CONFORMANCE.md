# Claiming conformance

This directory is the contract. `SPEC.md` states the behaviour as numbered requirements and
`fixtures/` holds the cases that decide whether an implementation meets them. Both are
language-neutral: an implementation in any language can run them, and none of it depends on the
npm or PyPI packages.

## Getting the suite

The suite is versioned by `SPEC_VERSION`, and each version is tagged `spec/vX.Y.Z`, a series
separate from the package's own `vX.Y.Z` release tags.

```sh
git clone --depth 1 --branch spec/v1.4.1 https://github.com/Bubblegunn/proactive-gate
# or, to keep it beside your own source and update it deliberately
git subtree add --prefix spec https://github.com/Bubblegunn/proactive-gate spec/v1.4.1 --squash
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
adds a check or a field, a major changes an expectation. A new preset is a minor for the same
reason a new check is: 7.3 makes a policy that names an unknown preset a compile error, so nobody
already passes the fixture that exercises it.

## The honest status of this suite

Two implementations pass it, and the same person wrote both within hours of each other. That is
weaker evidence than it looks: agreement between two implementations by one author is closer to a
consistency check than to independent verification. A third implementation, written from `SPEC.md`
by someone who has not read the source, is what would test whether this document is enough. Until
that exists, treat the suite as a contract that has been used twice, not as a proven standard.

## Implementing this in your language

This is the one thing the project is actively asking for, and it is deliberately the last section
of this document: everything above is what you need, and nothing below it is required of you.

**The shape of the work.** A conforming implementation is a decision loop over an ordered list of
checks and a key-value store with a counter. There is no network, no dependency, no framework and
no content inspection anywhere in it. The TypeScript version is about 1,400 lines of source and the
Python sibling about the same, and most of that is the twelve checks, each of which is a small pure
function over a user, a candidate and an instant.

**The order to do it in**, which is how both existing versions were built:

1. Vendor the suite at a tag rather than a branch: `git clone --depth 1 --branch spec/vX.Y.Z` or a
   subtree, and assert in your tests that the `SPEC_VERSION` you vendored is the one you claim.
2. Write the fixture loader first. Each file under `fixtures/` is a policy plus a list of cases,
   each case an input and an expectation, and the loader is the only part that touches JSON.
3. Make one fixture pass, in this order: `consent`, then `quiet-hours/istanbul`, then
   `budget/daily-atomic-commit`. Those three exercise the whole spine: ordering, a wall clock in a
   named zone, and a counter that has to be atomic at commit.
4. Then the rest, in whatever order the failures suggest. `spec/SPEC.md` is numbered, and every
   fixture names the requirement it came from.

**What passing means** is defined above and is not negotiable in one direction: a fixture you do
not pass is declared in your skip file with a reason, in the open. Silence about a failing fixture
is the one thing that makes a conformance claim worthless.

**What you may leave out.** Presets, adapters, the JSON policy compiler, `explain()`, the CLI and
the simulator are all optional; the fixtures that exercise them are the ones to declare as skipped.
The twelve checks, the ordering rules, the store contract and the commit-time budget are not
optional, because they are what the word conform refers to.

**What we will do with it.** If you say it conforms and the fixtures agree, it goes in the README
next to the other two implementations, under your name, with the version of the spec it targets.
If it does not conform yet, say which fixtures and it goes in as a work in progress, because an
honest partial claim is more useful to a reader than an absent one.

**What we will not do.** We will not write it for you and then call it independent. The value of a
third implementation is exactly that its author was not us, so a version written here would be
worth less than the four days it took somebody else.

Issue [#16](https://github.com/Bubblegunn/proactive-gate/issues/16) is the place to say you are
starting, so two people do not write the same one.
