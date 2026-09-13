package proactivegate

import (
	"encoding/json"
	"fmt"
	"sync/atomic"
	"time"
)

const commitTTLSeconds = 2 * daySeconds

// Gate is a compiled policy: an ordered list of checks bound to a store.
// Create one from explicit checks with NewGate, or from a JSON policy
// document with NewGateFromPolicy.
type Gate struct {
	checks       []Check
	consumers    []Check // the checks with Consume, in policy order
	inner        Store   // the caller's store, unprefixed
	store        Store   // inner under the policy's key prefix
	onStoreError string  // "open" or "closed"
	sequence     atomic.Int64
}

// GateOptions is how a gate is built from checks in code.
type GateOptions struct {
	Checks []Check
	Store  Store
	// OnStoreError decides what a store failure means for a check: "open"
	// lets the candidate through and records the failure in the trace;
	// "closed" rejects. Default "open".
	OnStoreError string
	// KeyPrefix prefixes every key the gate writes. Default "pg:".
	KeyPrefix string
}

// NewGate builds a gate over an explicit check list.
func NewGate(o GateOptions) *Gate {
	store := o.Store
	if store == nil {
		store = NewMemoryStore()
	}
	prefix := o.KeyPrefix
	if prefix == "" {
		prefix = "pg:"
	}
	onStoreError := o.OnStoreError
	if onStoreError == "" {
		onStoreError = "open"
	}
	g := &Gate{
		checks:       append([]Check(nil), o.Checks...),
		inner:        store,
		store:        prefixedStore{inner: store, prefix: prefix},
		onStoreError: onStoreError,
	}
	for _, c := range g.checks {
		if c.Consume != nil {
			g.consumers = append(g.consumers, c)
		}
	}
	return g
}

// Checks returns the compiled check list.
func (g *Gate) Checks() []Check { return g.checks }

// InnerStore returns the caller's store, without the key prefix applied.
func (g *Gate) InnerStore() Store { return g.inner }

func pickSurfaces(user *UserState, candidate *Candidate) []string {
	wanted := candidate.Surfaces
	if len(wanted) == 0 {
		wanted = []string{"feed"}
	}
	if len(user.Surfaces) == 0 {
		return wanted
	}
	var out []string
	for _, s := range wanted {
		if contains(user.Surfaces, s) {
			out = append(out, s)
		}
	}
	return out
}

// Evaluate runs every check in order and never returns an error for a check
// failure; what happened is in the trace.
func (g *Gate) Evaluate(input EvaluateInput) *Decision {
	now := input.Now
	if now.IsZero() {
		now = time.Now()
	}
	priority := input.Candidate.Priority
	if priority == "" {
		priority = PriorityNormal
	}
	var trace []TraceEntry
	var shadowed []string
	var nearLimit []NearLimitEntry
	surfaces := pickSurfaces(input.User, input.Candidate)
	var deliverAt *time.Time

	finish := func(allowed bool, rejectedBy, deferredBy string, retryAt *time.Time, reason string) *Decision {
		d := &Decision{
			ID:          fmt.Sprintf("%s:%s:%s#%d", input.User.ID, input.Candidate.ID, isoMillis(now), g.sequence.Add(1)),
			Allowed:     allowed,
			UserID:      input.User.ID,
			CandidateID: input.Candidate.ID,
			Surfaces:    surfaces,
			Shadowed:    shadowed,
			NearLimit:   nearLimit,
			Trace:       trace,
			EvaluatedAt: now,
			RejectedBy:  rejectedBy,
			DeferredBy:  deferredBy,
			RetryAt:     retryAt,
			Reason:      reason,
		}
		if allowed {
			d.DeliverAt = deliverAt
		} else {
			d.Surfaces = []string{}
		}
		return d
	}

	for _, check := range g.checks {
		started := time.Now()
		ctx := &CheckContext{
			User:      input.User,
			Candidate: input.Candidate,
			Now:       now,
			Priority:  priority,
			Store:     g.store,
			Surfaces:  surfaces,
		}
		outcome, err := check.Run(ctx)
		ms := float64(time.Since(started).Microseconds()) / 1000
		if err != nil {
			if g.onStoreError == "closed" {
				trace = append(trace, TraceEntry{ID: check.ID, Outcome: OutcomeReject, Reason: fmt.Sprintf("check threw (%s); failing closed", err), Ms: ms})
				return finish(false, check.ID, "", nil, fmt.Sprintf("check %q failed and the gate fails closed: %s", check.ID, err))
			}
			trace = append(trace, TraceEntry{ID: check.ID, Outcome: OutcomeSkip, Reason: fmt.Sprintf("check threw (%s); failing open", err), Ms: ms})
			continue
		}
		if check.NonRejecting && (outcome.Kind == OutcomeReject || outcome.Kind == OutcomeDefer) {
			// A non-rejecting check that tries to stop evaluation is a bug in
			// the check, not a decision about the user (3.2).
			trace = append(trace, TraceEntry{ID: check.ID, Outcome: OutcomeSkip, Reason: fmt.Sprintf("non-rejecting check returned %s (%s); ignored", outcome.Kind, outcome.Reason), Ms: ms})
			continue
		}
		stops := outcome.Kind == OutcomeReject || outcome.Kind == OutcomeDefer
		entry := TraceEntry{ID: check.ID, Outcome: outcome.Kind, Reason: outcome.Reason, Ms: ms}
		if stops && check.Shadow {
			entry.Shadow = true
		}
		trace = append(trace, entry)
		if outcome.Kind == OutcomePass && outcome.NearLimit != nil {
			nearLimit = append(nearLimit, NearLimitEntry{Check: check.ID, Used: outcome.NearLimit.Used, Limit: outcome.NearLimit.Limit})
		}
		if stops && check.Shadow {
			shadowed = append(shadowed, check.ID)
			continue
		}
		switch outcome.Kind {
		case OutcomeReject:
			return finish(false, check.ID, "", nil, outcome.Reason)
		case OutcomeDefer:
			return finish(false, "", check.ID, outcome.RetryAt, outcome.Reason)
		case OutcomeAdjust:
			if outcome.DeliverAt != nil {
				at := *outcome.DeliverAt
				deliverAt = &at
			}
			if outcome.Surfaces != nil {
				surfaces = outcome.Surfaces
			}
		}
	}
	return finish(true, "", "", nil, "")
}

// Commit consumes one unit of every budget-like check, in order, and returns
// false when a unit was taken by a concurrent delivery in the meantime (5.2).
// It is idempotent on the decision id: a second call returns the first result
// without incrementing (5.3). Committing a decision that was not allowed
// returns false without touching the store (5.4).
func (g *Gate) Commit(decision *Decision, input EvaluateInput) bool {
	if !decision.Allowed {
		return false
	}
	if len(g.consumers) == 0 {
		return true
	}
	now := input.Now
	if now.IsZero() {
		now = decision.EvaluatedAt
	}
	priority := input.Candidate.Priority
	if priority == "" {
		priority = PriorityNormal
	}
	marker := "commit:" + decision.ID
	seen, ok, err := g.store.Get(marker)
	if err != nil {
		return g.onStoreError == "open"
	}
	if ok {
		return seen == "1"
	}
	commitOK := true
	for _, check := range g.consumers {
		ctx := &CheckContext{
			User:      input.User,
			Candidate: input.Candidate,
			Now:       now,
			Priority:  priority,
			Store:     g.store,
			Surfaces:  decision.Surfaces,
		}
		ok, err := check.Consume(ctx)
		if err != nil {
			return g.onStoreError == "open"
		}
		if !ok {
			commitOK = false
			break
		}
	}
	value := "0"
	if commitOK {
		value = "1"
	}
	if err := g.store.Set(marker, value, commitTTLSeconds); err != nil {
		return g.onStoreError == "open"
	}
	return commitOK
}

// Record tells the gate what happened after delivery so cooldowns can learn.
// Only "dismissed" is recorded; other events are accepted and ignored.
func (g *Gate) Record(userID, candidateType, event string, at time.Time) error {
	if event != "dismissed" {
		return nil
	}
	if at.IsZero() {
		at = time.Now()
	}
	key := dismissalKey(userID, candidateType)
	raw, ok, err := g.store.Get(key)
	if err != nil {
		return err
	}
	var stamps []int64
	if ok {
		if err := json.Unmarshal([]byte(raw), &stamps); err != nil {
			return err
		}
	}
	keepFrom := at.UnixMilli() - 90*daySeconds*1000
	var next []int64
	for _, t := range stamps {
		if t >= keepFrom {
			next = append(next, t)
		}
	}
	next = append(next, at.UnixMilli())
	text, err := json.Marshal(next)
	if err != nil {
		return err
	}
	return g.store.Set(key, string(text), 90*daySeconds)
}
