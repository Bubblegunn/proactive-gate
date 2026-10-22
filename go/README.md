# proactive-gate in Go

An independent implementation of the behaviour contract in
[`../spec/SPEC.md`](../spec/SPEC.md), written against the fixtures rather than
ported from the TypeScript source. It targets spec version **1.6.0**, pinned
by the `spec/v1.6.0` tag, and passes every fixture in [`../spec/fixtures`](../spec/fixtures), the `lessons/`
fixtures for the 1.6.0 additions included, with none skipped
([`../spec/skip/go.txt`](../spec/skip/go.txt) lists no fixture). A denied decision carries
`NextAllowedAt` (spec 3.6) when the check that denied it can name the instant.

No dependencies beyond the Go standard library. The IANA zone handling reads
the system time zone database through `time.LoadLocation`, which is part of
the toolchain's promise rather than a dependency.

## Install

The module lives in this subdirectory, so its versions are tagged `go/vX.Y.Z`, separately from
the package's `vX.Y.Z` releases and the spec's `spec/vX.Y.Z`:

```sh
go get github.com/Bubblegunn/proactive-gate/go@v0.2.0
```

```go
package main

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/Bubblegunn/proactive-gate/go/proactivegate"
)

func main() {
	var policy proactivegate.Policy
	_ = json.Unmarshal([]byte(`{"specVersion":"1.0.0","checks":[{"id":"consent"},{"id":"dailyBudget","limit":3}]}`), &policy)
	gate, err := proactivegate.NewGateFromPolicy(&policy, proactivegate.NewMemoryStore())
	if err != nil {
		panic(err)
	}
	input := proactivegate.EvaluateInput{
		User:      &proactivegate.UserState{ID: "u1", Consent: true, Timezone: "Europe/Istanbul"},
		Candidate: &proactivegate.Candidate{ID: "c1", Type: "reminder"},
		Now:       time.Now(),
	}
	decision := gate.Evaluate(input)
	if decision.Allowed && gate.Commit(decision, input) {
		fmt.Println("send")
	} else {
		fmt.Println("held:", decision.Reason)
	}
}
```

`NewMemoryStore` is correct for one process. Across processes, implement the `Store` interface in
`proactivegate/types.go` over a shared store with an atomic increment.

## Layout

- `proactivegate/` is the library: the decision loop over an ordered list of
  checks and the key-value store with an atomic counter.
  - `types.go` the public shapes: user, candidate, decision, outcome, store.
  - `clock.go` the calendar arithmetic: local minutes and days in a zone, the
    quiet-window resolution (a date beats a weekday beats the default, and a
    window belongs to the day it opens on), ISO weeks, and the four-digit
    years the spec's date format needs below year 1000.
  - `store.go` the `Store` contract, an in-memory implementation, and the key
    prefixing.
  - `checks.go` the checks a JSON policy can name, including the checks added in 1.6.0.
  - `values.go` the readers for instants, counts and flags, which accept the Go and the JSON forms of each.
  - `zone.go` the effective zone (device zone, then profile zone, then none) and
    the transactional and commitment tests (spec 9.2, 9.4, 9.7).
  - `presets.go` the named preset expansions.
  - `policy.go` the JSON policy compiler; unknown check ids and preset names
    are rejected at compile time with the known vocabulary named (spec 7.3).
  - `gate.go` `Evaluate`, `Commit` (atomic, idempotent on the decision id) and
    `Record`. `Record(user, candidate, event, at)` returns an error for a nil
    user, or a dismissal with no candidate; it writes nothing in that case.
  - `target.go` the adapter that plugs the gate into the runner.
- `conformance/` is the runner: it reads the fixtures as data and executes
  them against a `Target` it knows nothing about. `conformance.Stub` is a
  target that fails everything, included so the runner can prove it reports
  failure precisely.
- `cmd/pg-conformance/` is the command line around the runner.

## Running the suite

From this directory:

```sh
go test ./...                    # the whole suite, plus the SPEC_VERSION pin
go run ./cmd/pg-conformance      # pass/fail/skip per fixture, then the totals
go run ./cmd/pg-conformance -stub    # every fixture must fail, precisely
go run ./cmd/pg-conformance -json    # {"ran":N,"failures":[...]} for tooling
```

`go test` also asserts that the `SpecVersion` this module declares equals the
`spec/SPEC_VERSION` vendored beside it, so the suite cannot be updated
underneath the claim.

## What the pieces mean

A fixture is a policy plus a list of cases; for each case the gate evaluates
the policy against the input at the given `now`, and the runner compares the
decision field by field the way `../spec/CONFORMANCE.md` describes. `commit`
cases then commit the decision and `store_after` cases read the store back
through the same key prefix.
