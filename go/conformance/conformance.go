// Package conformance is a language-neutral runner for the proactive-gate
// behaviour suite. It reads spec/fixtures as data and executes them against
// an implementation behind the Target interface; it knows nothing about any
// particular implementation.
//
// The comparison rules are the ones spec/CONFORMANCE.md states field by
// field: allowed, the ordered trace ids, rejectedBy and deferredBy, retryAt
// and deliverAt as ISO instants, surfaces, shadowed and nearLimit when the
// fixture asserts them, reason_pattern as a regular expression, the commit
// result, and store_after read back through the implementation's own store.
package conformance

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

/* ------------------------------------------------------------------------ */
/* The seam: what the runner needs from an implementation.                   */
/* ------------------------------------------------------------------------ */

// Store is the key-value contract the suite needs, identical to the one the
// specification gives the gate: a get that can say absent, a set with an
// optional TTL, an atomic increment that never extends an existing expiry,
// and a delete.
type Store interface {
	Get(key string) (value string, ok bool, err error)
	Set(key, value string, ttlSeconds int64) error
	Incr(key string, ttlSeconds int64) (int64, error)
	Del(key string) error
}

// Input is one fixture test case, handed to the target as raw JSON: how a
// user or a candidate is decoded is the implementation's business.
type Input struct {
	User      json.RawMessage
	Candidate json.RawMessage
	Now       string
}

// Decision is the runner's view of an evaluation result: exactly the fields
// CONFORMANCE.md compares, and nothing else.
type Decision struct {
	Allowed    bool
	Trace      []string // the ordered ids of the checks that ran
	RejectedBy string   // empty when absent
	DeferredBy string   // empty when absent
	RetryAt    string   // ISO instant ending Z, empty when absent
	DeliverAt  string   // ISO instant ending Z, empty when absent
	Surfaces   []string
	Shadowed   []string
	NearLimit  []NearLimit
	Reason     string
	// Handle lets a target carry its own decision object from Evaluate to
	// Commit; the runner never reads it.
	Handle any
}

// NearLimit is one entry of the decision's nearLimit list.
type NearLimit struct {
	Check string `json:"check"`
	Used  int64  `json:"used"`
	Limit int64  `json:"limit"`
}

// Session is one fixture under test: a store the runner seeds and reads back,
// and the evaluate/commit pair the spec describes.
type Session interface {
	// Store is a fresh, empty store for this fixture. The runner writes
	// store_seed into it before the tests and reads store_after out of it.
	Store() Store
	// Evaluate runs the policy against one input.
	Evaluate(input Input) (*Decision, error)
	// Commit commits a decision Evaluate produced (5.2, 5.3, 5.4).
	Commit(d *Decision, input Input) (bool, error)
}

// Target is an implementation under test. Begin compiles the fixture's
// policy; a compile error is reported as a fixture failure, not a crash.
type Target interface {
	Begin(policy json.RawMessage) (Session, error)
}

/* ------------------------------------------------------------------------ */
/* The fixtures.                                                             */
/* ------------------------------------------------------------------------ */

// Fixture mirrors spec/schema/fixture.schema.json.
type Fixture struct {
	SpecVersion string            `json:"spec_version"`
	Since       string            `json:"since"`
	Name        string            `json:"name"`
	Description string            `json:"description"`
	Policy      json.RawMessage   `json:"policy"`
	StoreSeed   map[string]string `json:"store_seed"`
	Tests       []Test            `json:"tests"`
}

// Test is one case of a fixture.
type Test struct {
	Description string `json:"description"`
	Input       struct {
		User      json.RawMessage `json:"user"`
		Candidate json.RawMessage `json:"candidate"`
		Now       string          `json:"now"`
	} `json:"input"`
	Commit bool   `json:"commit"`
	Expect Expect `json:"expect"`
}

// Expect is what a test asserts. Slices stay nil when the fixture does not
// assert them, so "absent" and "present but empty" remain distinct.
type Expect struct {
	Allowed       bool              `json:"allowed"`
	RejectedBy    *string           `json:"rejectedBy"`
	DeferredBy    *string           `json:"deferredBy"`
	RetryAt       string            `json:"retryAt"`
	Surfaces      []string          `json:"surfaces"`
	DeliverAt     string            `json:"deliverAt"`
	Trace         []string          `json:"trace"`
	Shadowed      []string          `json:"shadowed"`
	NearLimit     []NearLimit       `json:"nearLimit"`
	ReasonPattern string            `json:"reason_pattern"`
	Commit        *bool             `json:"commit"`
	StoreAfter    map[string]string `json:"store_after"`
}

// LoadFixtures reads every fixture file under dir, in sorted path order.
func LoadFixtures(dir string) ([]*Fixture, error) {
	var files []string
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && strings.HasSuffix(d.Name(), ".json") {
			files = append(files, path)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(files)
	var out []*Fixture
	for _, f := range files {
		raw, err := readFile(f)
		if err != nil {
			return nil, err
		}
		var fx Fixture
		if err := json.Unmarshal(raw, &fx); err != nil {
			return nil, fmt.Errorf("%s: %w", f, err)
		}
		out = append(out, &fx)
	}
	return out, nil
}

// ReadSkips parses a skip file: one fixture name per line, the reason after
// a '#'. A missing file is an empty list, not an error.
func ReadSkips(path string) (map[string]string, error) {
	raw, err := readFile(path)
	if err != nil {
		return map[string]string{}, nil
	}
	out := map[string]string{}
	for _, line := range strings.Split(string(raw), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		name, reason, _ := strings.Cut(trimmed, "#")
		out[strings.TrimSpace(name)] = strings.TrimSpace(reason)
	}
	return out, nil
}

/* ------------------------------------------------------------------------ */
/* Running one fixture.                                                      */
/* ------------------------------------------------------------------------ */

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func equalNearLimit(a, b []NearLimit) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// RunFixture runs one fixture against the target and returns the list of
// mismatches; an empty list means the fixture conforms.
func RunFixture(f *Fixture, target Target) []string {
	var failures []string
	session, err := target.Begin(f.Policy)
	if err != nil {
		return []string{fmt.Sprintf("%s: policy: %s", f.Name, err)}
	}
	store := session.Store()
	var meta struct {
		KeyPrefix string `json:"keyPrefix"`
	}
	_ = json.Unmarshal(f.Policy, &meta)
	prefix := meta.KeyPrefix
	if prefix == "" {
		prefix = "pg:"
	}
	for key, value := range f.StoreSeed {
		if err := store.Set(prefix+key, value, 0); err != nil {
			failures = append(failures, fmt.Sprintf("%s: store_seed %q: %s", f.Name, key, err))
		}
	}
	for i, t := range f.Tests {
		at := fmt.Sprintf("%s [%d] %s", f.Name, i, t.Description)
		input := Input{User: t.Input.User, Candidate: t.Input.Candidate, Now: t.Input.Now}
		decision, err := session.Evaluate(input)
		if err != nil {
			failures = append(failures, fmt.Sprintf("%s: evaluate: %s", at, err))
			continue
		}
		e := t.Expect
		check := func(field string, actual, expected any) {
			a, _ := json.Marshal(actual)
			b, _ := json.Marshal(expected)
			if string(a) != string(b) {
				failures = append(failures, fmt.Sprintf("%s: %s expected %s, got %s", at, field, b, a))
			}
		}
		check("allowed", decision.Allowed, e.Allowed)
		check("trace", decision.Trace, e.Trace)
		var rejectedBy, deferredBy any
		if decision.RejectedBy != "" {
			rejectedBy = decision.RejectedBy
		}
		if decision.DeferredBy != "" {
			deferredBy = decision.DeferredBy
		}
		var expRejectedBy, expDeferredBy any
		if e.RejectedBy != nil {
			expRejectedBy = *e.RejectedBy
		}
		if e.DeferredBy != nil {
			expDeferredBy = *e.DeferredBy
		}
		check("rejectedBy", rejectedBy, expRejectedBy)
		check("deferredBy", deferredBy, expDeferredBy)
		check("retryAt", decision.RetryAt, e.RetryAt)
		if e.Surfaces != nil {
			check("surfaces", decision.Surfaces, e.Surfaces)
		}
		check("deliverAt", decision.DeliverAt, e.DeliverAt)
		if e.Shadowed != nil {
			check("shadowed", decision.Shadowed, e.Shadowed)
		}
		if e.NearLimit != nil {
			if !equalNearLimit(decision.NearLimit, e.NearLimit) {
				a, _ := json.Marshal(decision.NearLimit)
				b, _ := json.Marshal(e.NearLimit)
				failures = append(failures, fmt.Sprintf("%s: nearLimit expected %s, got %s", at, b, a))
			}
		}
		if e.ReasonPattern != "" {
			re, err := regexp.Compile(e.ReasonPattern)
			if err != nil {
				failures = append(failures, fmt.Sprintf("%s: bad reason_pattern %q: %s", at, e.ReasonPattern, err))
			} else if !re.MatchString(decision.Reason) {
				failures = append(failures, fmt.Sprintf("%s: reason %q does not match /%s/", at, decision.Reason, e.ReasonPattern))
			}
		}
		if t.Commit {
			committed, err := session.Commit(decision, input)
			if err != nil {
				failures = append(failures, fmt.Sprintf("%s: commit: %s", at, err))
			} else if e.Commit != nil {
				check("commit", committed, *e.Commit)
			}
		}
		for key, value := range e.StoreAfter {
			actual, ok, err := store.Get(prefix + key)
			if err != nil {
				failures = append(failures, fmt.Sprintf("%s: store %s: %s", at, key, err))
				continue
			}
			var actualAny any
			if ok {
				actualAny = actual
			}
			check("store "+key, actualAny, value)
		}
	}
	return failures
}

/* ------------------------------------------------------------------------ */
/* The report.                                                               */
/* ------------------------------------------------------------------------ */

// Status of one fixture.
type Status string

const (
	StatusPass Status = "pass"
	StatusFail Status = "fail"
	StatusSkip Status = "skip"
)

// Result is the outcome of one fixture.
type Result struct {
	Name     string
	Status   Status
	Reason   string   // the declared reason for a skip
	Failures []string // the mismatches for a fail
}

// Report is a full run: one result per fixture plus the totals.
type Report struct {
	Results []Result
	Passed  int
	Failed  int
	Skipped int
}

// Run executes every fixture not declared in skips and reports per-fixture
// results. Skipped fixtures are reported, not silently omitted.
func Run(fixtures []*Fixture, skips map[string]string, target Target) *Report {
	r := &Report{}
	for _, f := range fixtures {
		if reason, ok := skips[f.Name]; ok {
			r.Results = append(r.Results, Result{Name: f.Name, Status: StatusSkip, Reason: reason})
			r.Skipped++
			continue
		}
		failures := RunFixture(f, target)
		if len(failures) == 0 {
			r.Results = append(r.Results, Result{Name: f.Name, Status: StatusPass})
			r.Passed++
		} else {
			r.Results = append(r.Results, Result{Name: f.Name, Status: StatusFail, Failures: failures})
			r.Failed++
		}
	}
	return r
}

// Text renders the report the way the issue asks for it: one line per
// fixture, the failures spelled out, and the totals at the end.
func (r *Report) Text() string {
	var b strings.Builder
	for _, res := range r.Results {
		switch res.Status {
		case StatusPass:
			fmt.Fprintf(&b, "pass  %s\n", res.Name)
		case StatusSkip:
			fmt.Fprintf(&b, "skip  %s", res.Name)
			if res.Reason != "" {
				fmt.Fprintf(&b, "  # %s", res.Reason)
			}
			b.WriteString("\n")
		case StatusFail:
			fmt.Fprintf(&b, "fail  %s\n", res.Name)
			for _, f := range res.Failures {
				fmt.Fprintf(&b, "      %s\n", f)
			}
		}
	}
	fmt.Fprintf(&b, "%d passed, %d failed, %d skipped\n", r.Passed, r.Failed, r.Skipped)
	return b.String()
}
