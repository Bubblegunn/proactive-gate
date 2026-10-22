package proactivegate

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/Bubblegunn/proactive-gate/go/conformance"
)

// SpecVersion is the version of spec/SPEC.md this implementation targets.
// The test suite asserts it equals the vendored spec/SPEC_VERSION, so a suite
// update cannot silently move the contract.
const SpecVersion = "1.6.0"

// ConformanceTarget adapts this implementation to the runner's Target
// interface. The runner owns the fixtures; this type owns the gate.
type ConformanceTarget struct{}

// Begin compiles the fixture's policy and binds a gate to a fresh store.
func (ConformanceTarget) Begin(policy json.RawMessage) (conformance.Session, error) {
	var p Policy
	if err := json.Unmarshal(policy, &p); err != nil {
		return nil, err
	}
	gate, err := NewGateFromPolicy(&p, NewMemoryStore())
	if err != nil {
		return nil, err
	}
	return &conformanceSession{gate: gate}, nil
}

type conformanceSession struct {
	gate *Gate
}

func (s *conformanceSession) Store() conformance.Store {
	// Hand the runner the unprefixed store: it applies the policy's keyPrefix
	// itself when seeding and when reading store_after.
	return s.gate.InnerStore()
}

func (s *conformanceSession) Evaluate(input conformance.Input) (*conformance.Decision, error) {
	var user UserState
	if err := json.Unmarshal(input.User, &user); err != nil {
		return nil, fmt.Errorf("user: %w", err)
	}
	var candidate Candidate
	if err := json.Unmarshal(input.Candidate, &candidate); err != nil {
		return nil, fmt.Errorf("candidate: %w", err)
	}
	now, err := time.Parse(time.RFC3339Nano, input.Now)
	if err != nil {
		return nil, fmt.Errorf("now: %w", err)
	}
	flags, err := decodeFlags(input.Flags)
	if err != nil {
		return nil, fmt.Errorf("flags: %w", err)
	}
	d := s.gate.Evaluate(EvaluateInput{User: &user, Candidate: &candidate, Now: now, Flags: flags})
	view := &conformance.Decision{
		Allowed:    d.Allowed,
		Reason:     d.Reason,
		Handle:     d,
		Surfaces:   d.Surfaces,
		Shadowed:   d.Shadowed,
		RejectedBy: d.RejectedBy,
		DeferredBy: d.DeferredBy,
	}
	for _, entry := range d.Trace {
		view.Trace = append(view.Trace, entry.ID)
	}
	for _, nl := range d.NearLimit {
		view.NearLimit = append(view.NearLimit, conformance.NearLimit{Check: nl.Check, Used: nl.Used, Limit: nl.Limit})
	}
	// The runner compares fields as JSON: an empty list serializes as [] and
	// an absent one as null, so the view keeps them distinct.
	if view.Surfaces == nil {
		view.Surfaces = []string{}
	}
	if view.Shadowed == nil {
		view.Shadowed = []string{}
	}
	if view.Trace == nil {
		view.Trace = []string{}
	}
	if view.NearLimit == nil {
		view.NearLimit = []conformance.NearLimit{}
	}
	if d.RetryAt != nil {
		view.RetryAt = isoMillis(*d.RetryAt)
	}
	if d.DeliverAt != nil {
		view.DeliverAt = isoMillis(*d.DeliverAt)
	}
	if d.NextAllowedAt != nil {
		view.NextAllowedAt = isoMillis(*d.NextAllowedAt)
	}
	return view, nil
}

func (s *conformanceSession) Commit(d *conformance.Decision, input conformance.Input) (bool, error) {
	decision, ok := d.Handle.(*Decision)
	if !ok {
		return false, fmt.Errorf("decision was not produced by this session")
	}
	var user UserState
	if err := json.Unmarshal(input.User, &user); err != nil {
		return false, err
	}
	var candidate Candidate
	if err := json.Unmarshal(input.Candidate, &candidate); err != nil {
		return false, err
	}
	now, err := time.Parse(time.RFC3339Nano, input.Now)
	if err != nil {
		return false, err
	}
	flags, err := decodeFlags(input.Flags)
	if err != nil {
		return false, err
	}
	return s.gate.Commit(decision, EvaluateInput{User: &user, Candidate: &candidate, Now: now, Flags: flags}), nil
}

// decodeFlags reads a fixture's flags object. An absent or null object is no
// flags at all, and every flag reads as absent.
// decodeFlags reads the fixture's flags object. Only a literal true or false is a flag. Any other value, such as
// null or "no", is not false, so the flag stops nothing (SPEC 9.13; D5).
func decodeFlags(raw json.RawMessage) (map[string]bool, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(raw, &all); err != nil {
		return nil, err
	}
	flags := make(map[string]bool, len(all))
	for name, value := range all {
		if isTrueLiteral(value) {
			flags[name] = true
		} else if isFalseLiteral(value) {
			flags[name] = false
		}
	}
	return flags, nil
}
