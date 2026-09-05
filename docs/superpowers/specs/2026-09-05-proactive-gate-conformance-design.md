# proactive-gate: the conformance suite as an artifact

Design, 5 September 2026. Status: sections 1 to 5 implemented in 0.2.4; section 6 designed and
deliberately not run.

## The problem

This package carries something unusual for its size: `spec/SPEC.md` states the behaviour as
numbered RFC 2119 requirements, `spec/fixtures` holds 32 language-neutral cases, and two
independent implementations, TypeScript and Python, are held to all of them on every push.

None of that is reachable by anyone else. `spec/` is a directory inside a repository whose npm
tarball does not contain it, its version is a file nobody outside the repository reads, and the
README describes it in one paragraph that ends "a third implementation starts from the fixtures,
not from this source" without saying how. A contract nobody can obtain is a contract with
ourselves.

The goal is narrow and worth stating so it is not confused with a larger one: make the suite
consumable and claimable by a third implementation. Not to found a standard.

## 1. What the suite has to become

Three properties, in the order they matter.

**Obtainable without depending on either package.** An implementation in Go or Rust must be able
to fetch the fixtures without npm or PyPI. Git is the common denominator, which is what the
JSON Schema Test Suite settled on: its documented workflow is to "clone the main branch of this
repository as a git submodule or git subtree". A JavaScript implementation should also find the
suite in `node_modules`, because that path costs one line and removes a clone.

**Independently versioned.** `SPEC_VERSION` already exists and every fixture declares the version
it targets, which `test/spec-lint.mjs` enforces. What is missing is an address: a way to say "I
target 1.2.0" and have that resolve to bytes. Package release tags (`v0.2.4`) are the wrong
anchor because the spec version and the package version move independently, and a reader cannot
tell which package release carries which spec.

**Claimable.** An implementation must be able to state that it conforms, and a reader must be
able to check the claim. That needs a written rule for what passing means and an honest place to
declare what was skipped.

## 2. Addressing: a separate tag series

`spec/vX.Y.Z` git tags, distinct from the package's `vX.Y.Z` release tags. A tag is pushed when
`SPEC_VERSION` changes, and it names the tree at that moment.

An implementation then pins the suite at `spec/v1.2.0` and declares that version in its own
metadata. The two series never collide because the spec tags carry the `spec/` prefix, and a
reader can move between them: the package's CHANGELOG records which spec version each release
targets.

Rejected: a separate repository for the spec. It would be honest about the boundary and it would
also mean two repositories, two CI setups and a submodule for our own tests, for a suite of 32
fixtures with two implementations. The cost lands today and the benefit lands only if a third
implementation appears. The tag series buys the addressing without the split, and the split
remains available later.

**This design does not push the tag.** Tag creation is the repository owner's, and the release
ruleset requires it. The convention and the check are implemented; the first `spec/v1.2.0` tag is
an owner action, recorded in CONTRIBUTING.

## 3. Distribution

`spec/` joins the npm `files` list, so `node_modules/proactive-gate/spec/fixtures` exists after an
install. That is 32 JSON files and about ninety kilobytes, in a package that otherwise ships only
`dist/src`. The cost is real and small; the benefit is that a JavaScript implementation, including
a competing one, can run the contract without cloning anything.

The Python wheel does not ship the fixtures. Its build packages `src/proactive_gate` only, and
adding data files to a wheel to serve a use case nobody has asked for would be speculative. Git
remains the answer there.

## 4. What passing means

Written into `spec/CONFORMANCE.md` rather than left to the reader:

- An implementation conforms at version X when, for every fixture whose `spec_version` is X, every
  assertion in every test's `expect` holds. The comparison is exact on `allowed`, `trace`,
  `rejectedBy`, `deferredBy`, `retryAt`, `deliverAt` and, where present, `surfaces`, `shadowed`,
  `nearLimit`, `commit` and `store_after`; `reason_pattern` is a regular expression matched against
  the decision's reason. This mirrors what both existing runners already do, so the rule describes
  the suite rather than inventing a second one.
- `ms` in a trace entry is informative and never asserted, which SPEC.md 8.1 already says.
- A skip is declared in `spec/skip/<impl>.txt`, one fixture name per line with a reason after a
  `#`. SPEC.md already requires that file to be empty at a stable release. The honest form of a
  partial claim is "conforms to 1.2.0 except these three fixtures, for this reason", not silence.
- An implementation states the version it targets and asserts in its own CI that the value equals
  the suite's `SPEC_VERSION`, which SPEC.md already requires and both implementations already do.

## 5. The results table

A table in the README showing both implementations against the current suite, generated by
`npm run conformance-table` and checked in CI by `--check`, so it cannot drift from what the
fixtures do. Typing that table by hand would make it a claim rather than a measurement, which is
the failure this repository exists to point at in other people's writing.

The script runs each implementation's own runner as a child process: the TypeScript one through
`dist/src/conformance.js`, the Python one through `PYTHONPATH=python/src` and
`proactive_gate.conformance`, which works because the Python package has no runtime dependencies.
It reports, per implementation, the spec version targeted, fixtures run, passed, and skipped with
their reasons. A failure is a non-zero exit, not a row that says "failed", because a conformance
table that can show a red cell is a dashboard, and this is a gate.

CI runs it in a dedicated job with both runtimes rather than bolting Python onto an existing Node
job.

## 6. The study: is the specification enough? (designed, not run)

Everything above assumes the specification is sufficient to build against. Nobody has tested that,
and the two existing implementations are poor evidence because the same person wrote both, hours
apart, with the source of one open while writing the other.

**Method.** A third implementation, in a language neither of the current two uses, written from
`spec/SPEC.md` alone. The author must not read `src/` or `python/src/`, and must not run the
fixtures until the implementation is complete: the fixtures are the examination, and consulting
them during construction turns the experiment into supervised learning. When it is finished, run
the suite once and record every failure before fixing anything.

**Measured.** The number of fixtures failing on that first run, and for each failure, whether the
specification underdetermined the behaviour or the author misread a requirement that was clear.
That classification is the result; the pass count alone is not, because a low count that came from
guessing correctly is not evidence about the document.

**Interesting result.** Failures cluster in identifiable clauses, and each one names a sentence
that has to be rewritten. Section 5 on atomic commit and section 6 on the clock are the obvious
candidates, because both describe behaviour that emerges from ordering rather than from a value:
5.6 forbids a read-then-write claim without saying what a conforming claim looks like in a store
without atomic increment, and 6.5's precedence rule for a window crossing midnight is stated once
in prose and never as a table.

**Negative result, and it is publishable.** The third implementation passes on the first run. That
would be strong evidence that a 200-line contract with fixtures is enough to reproduce behaviour
across languages, which is a claim about specifications rather than about this library, and worth
writing down either way.

**Threats.** One author is one sample. The author knows the problem domain from having read this
README, which cannot be undone; the mitigation is to record what they already knew before starting.
And an implementation written to be examined is not an implementation written to be used.

Three to five days. It belongs after the launch week, and it is the only item here with a shape
that could become a paper rather than a repository.

## 7. Positioning, with what was verified and what was thrown away

The README gains a short section saying what this layer is and is not, resting on two
specifications read at the source.

**MCP elicitation** (2026-07-28) is the closest existing mechanism and it is complementary rather
than competing. It "provides a standardized way for servers to request additional information from
users through the client during interactions", and those requests "occur *nested* inside other MCP
server features". The user already started something; the server needs input to finish it. Nothing
in that specification concerns whether a user may be contacted when they did not ask: no quiet
hours, no budget, no cooldown, no consent to be approached.

**A2A push notifications** are transport. Section 3.5.1 scopes them to "server-to-server
integrations, long-running tasks, event-driven architectures", and 3.5.3 delivers them "via HTTP
POST to client-registered webhook endpoints". Quiet hours, rate limits and notification budgets do
not appear.

So the gap is real and narrow: both answer *how* a message moves, neither answers *whether it
should be sent now*. That sentence is the whole positioning and it is all the evidence supports.

**Rejected: Kang and Diponegoro, arXiv 2606.31498.** An earlier research pass reported that this
paper names notification policy, quiet hours, rate limiting and message gating as protocol gaps and
calls for conformance mechanisms. It does not. Its taxonomy is membership, deliberation, voting,
dissent preservation, human escalation and audit or replay; human escalation covers routing
decisions to human authority, and the paper proposes no verification framework. It is not cited
here. A citation for a sentence a paper does not contain is the same failure this project's sibling
tool exists to catch, and it is worth recording that it was caught before it shipped rather than
quietly dropped.

**The precedent, and the risk.** The JSON Schema Test Suite is the working example of a
language-neutral fixture set becoming common ground: JSON files, a directory per draft, consumed as
a submodule or subtree, an `optional/` directory for cases considered optional, and implementations
across more than twenty languages. What made it work was a specification people already had to
implement, so the suite settled arguments that already existed.

That is exactly what this suite does not have. Nobody is arguing about notification gating, because
almost nobody has implemented it twice. Being early to a contract nobody adopts is indistinguishable
from being wrong, and the README says so in those terms rather than implying a standard exists. The
cost of being wrong is one directory and a table; the cost of not writing it down is that the second
implementation's agreement with the first proves nothing.

## What this does not change

No check, policy, default or fixture behaviour changes. A policy written before 0.2.4 behaves
identically after it. The suite gains an address, a rule for claiming conformance, a generated
table and a section of prose.
