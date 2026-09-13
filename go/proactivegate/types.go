// Package proactivegate is an independent Go implementation of the
// proactive-gate behaviour contract in spec/SPEC.md. It was written from the
// specification and the fixtures, not ported from the TypeScript source.
//
// The gate decides whether a proactive agent may reach a user right now:
// an ordered list of checks runs over a user, a candidate and an instant,
// and the first rejecting or deferring check stops the decision.
package proactivegate

import (
	"encoding/json"
	"fmt"
	"time"
)

// Priority of a candidate message. Higher priorities may bypass some checks.
type Priority string

const (
	PriorityLow      Priority = "low"
	PriorityNormal   Priority = "normal"
	PriorityHigh     Priority = "high"
	PriorityCritical Priority = "critical"
)

var priorityRank = map[Priority]int{
	PriorityLow: 0, PriorityNormal: 1, PriorityHigh: 2, PriorityCritical: 3,
}

func atLeast(p, floor Priority) bool { return priorityRank[p] >= priorityRank[floor] }

// QuietWindow is a quiet window in local time, "HH:MM" to "HH:MM".
// A start after the end crosses midnight.
type QuietWindow struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

// windowOrNull distinguishes three cases the schedule resolution depends on:
// the key is absent, the key is present and null, or the key holds a window.
type windowOrNull struct {
	set    bool
	window *QuietWindow
}

// QuietHours is either a plain window or a schedule. A schedule resolves one
// window per local date: dates[date], then days[weekday], then default.
type QuietHours struct {
	window *QuietWindow // set when the value is a plain window
	def    windowOrNull
	days   map[string]windowOrNull
	dates  map[string]windowOrNull
}

func (q *QuietHours) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if _, ok := raw["start"]; ok {
		var w QuietWindow
		if err := json.Unmarshal(data, &w); err != nil {
			return err
		}
		q.window = &w
		return nil
	}
	var decode = func(raw json.RawMessage) (windowOrNull, error) {
		if string(raw) == "null" {
			return windowOrNull{set: true}, nil
		}
		var w QuietWindow
		if err := json.Unmarshal(raw, &w); err != nil {
			return windowOrNull{}, err
		}
		return windowOrNull{set: true, window: &w}, nil
	}
	if v, ok := raw["default"]; ok {
		w, err := decode(v)
		if err != nil {
			return fmt.Errorf("quietHours.default: %w", err)
		}
		q.def = w
	}
	if v, ok := raw["days"]; ok {
		var m map[string]json.RawMessage
		if err := json.Unmarshal(v, &m); err != nil {
			return err
		}
		q.days = make(map[string]windowOrNull, len(m))
		for day, rv := range m {
			w, err := decode(rv)
			if err != nil {
				return fmt.Errorf("quietHours.days.%s: %w", day, err)
			}
			q.days[day] = w
		}
	}
	if v, ok := raw["dates"]; ok {
		var m map[string]json.RawMessage
		if err := json.Unmarshal(v, &m); err != nil {
			return err
		}
		q.dates = make(map[string]windowOrNull, len(m))
		for date, rv := range m {
			w, err := decode(rv)
			if err != nil {
				return fmt.Errorf("quietHours.dates.%s: %w", date, err)
			}
			q.dates[date] = w
		}
	}
	return nil
}

// UserState is everything the gate knows about the person it might interrupt.
type UserState struct {
	ID               string          `json:"id"`
	Consent          bool            `json:"consent"`
	ProactiveEnabled *bool           `json:"proactiveEnabled"`
	Mode             string          `json:"mode"`
	SnoozedUntil     *string         `json:"snoozedUntil"`
	MutedTypes       []string        `json:"mutedTypes"`
	Intensity        string          `json:"intensity"`
	Timezone         string          `json:"timezone"`
	QuietHours       *QuietHours     `json:"quietHours"`
	CreatedAt        *string         `json:"createdAt"`
	Surfaces         []string        `json:"surfaces"`
	Consents         map[string]bool `json:"consents"`
	LastInboundAt    *string         `json:"lastInboundAt"`
	Minor            bool            `json:"minor"`
	ExistingCustomer bool            `json:"existingCustomer"`
}

// Candidate is the thing the agent wants to say.
type Candidate struct {
	ID        string   `json:"id"`
	Type      string   `json:"type"`
	Priority  Priority `json:"priority"`
	Surfaces  []string `json:"surfaces"`
	Channel   string   `json:"channel"`
	Busy      bool     `json:"busy"`
	PAccept   *float64 `json:"pAccept"`
	PNeed     *float64 `json:"pNeed"`
	DedupeKey string   `json:"dedupeKey"`
	// Payload is free-form; the gate never reads it (spec 1.4).
	Payload json.RawMessage `json:"payload"`
}

// EvaluateInput is one evaluation: a user, a candidate and an instant.
// Now is supplied by the caller in fixtures; in library use a zero Now
// defaults to the current instant.
type EvaluateInput struct {
	User      *UserState
	Candidate *Candidate
	Now       time.Time
}

// OutcomeKind is what a single check may say.
type OutcomeKind string

const (
	OutcomePass   OutcomeKind = "pass"
	OutcomeReject OutcomeKind = "reject"
	OutcomeAdjust OutcomeKind = "adjust"
	OutcomeSkip   OutcomeKind = "skip"
	OutcomeDefer  OutcomeKind = "defer"
)

// NearLimit rides on a pass when a budget check is close to its limit.
type NearLimit struct {
	Used  int64 `json:"used"`
	Limit int64 `json:"limit"`
}

// Outcome is what a single check said.
type Outcome struct {
	Kind      OutcomeKind
	Reason    string
	DeliverAt *time.Time
	Surfaces  []string
	RetryAt   *time.Time
	NearLimit *NearLimit
}

func pass() Outcome                    { return Outcome{Kind: OutcomePass} }
func passReason(reason string) Outcome { return Outcome{Kind: OutcomePass, Reason: reason} }
func reject(reason string) Outcome     { return Outcome{Kind: OutcomeReject, Reason: reason} }
func skip(reason string) Outcome       { return Outcome{Kind: OutcomeSkip, Reason: reason} }
func deferTo(reason string, retryAt time.Time) Outcome {
	return Outcome{Kind: OutcomeDefer, Reason: reason, RetryAt: &retryAt}
}

// Store is the minimal key-value contract the gate needs. Get returns ok=false
// for an absent key. Incr is an atomic increment returning the new value; the
// TTL applies to a new key only and must never extend an existing key (5.8).
// Every method may fail; the gate decides per check whether a store failure
// fails open or closed.
type Store interface {
	Get(key string) (value string, ok bool, err error)
	Set(key, value string, ttlSeconds int64) error
	Incr(key string, ttlSeconds int64) (int64, error)
	Del(key string) error
}

// CheckContext is what a check sees: the input plus resolved convenience
// fields and the (already prefixed) store.
type CheckContext struct {
	User      *UserState
	Candidate *Candidate
	Now       time.Time
	Priority  Priority
	Store     Store
	Surfaces  []string
}

// Check is one step of the decision loop.
type Check struct {
	ID string
	// NonRejecting marks a check that may only adjust; a reject or defer from
	// it is recorded as a skip and never stops evaluation (3.2).
	NonRejecting bool
	// Shadow records what the check would have done without letting it stop
	// evaluation (4.1).
	Shadow bool
	Run    func(ctx *CheckContext) (Outcome, error)
	// Consume is set on budget-like checks: the gate calls it once per commit,
	// in check order, and a false return refuses the commit.
	Consume func(ctx *CheckContext) (bool, error)
}

// TraceEntry records one check that ran, in order.
type TraceEntry struct {
	ID      string      `json:"id"`
	Outcome OutcomeKind `json:"outcome"`
	Reason  string      `json:"reason,omitempty"`
	Ms      float64     `json:"ms"`
	Shadow  bool        `json:"shadow,omitempty"`
}

// NearLimitEntry is a budget pass that ran close to its limit (3.4).
type NearLimitEntry struct {
	Check string `json:"check"`
	Used  int64  `json:"used"`
	Limit int64  `json:"limit"`
}

// Decision is the gate's answer.
type Decision struct {
	// ID is unique per evaluation; Commit is idempotent on it.
	ID          string `json:"id"`
	Allowed     bool   `json:"allowed"`
	UserID      string `json:"userId"`
	CandidateID string `json:"candidateId"`
	// Surfaces to route to when allowed; empty when rejected or deferred.
	Surfaces   []string   `json:"surfaces"`
	DeliverAt  *time.Time `json:"deliverAt,omitempty"`
	RejectedBy string     `json:"rejectedBy,omitempty"`
	DeferredBy string     `json:"deferredBy,omitempty"`
	RetryAt    *time.Time `json:"retryAt,omitempty"`
	Reason     string     `json:"reason,omitempty"`
	// Shadowed lists the checks in shadow mode that would have stopped the run.
	Shadowed    []string         `json:"shadowed"`
	NearLimit   []NearLimitEntry `json:"nearLimit"`
	Trace       []TraceEntry     `json:"trace"`
	EvaluatedAt time.Time        `json:"evaluatedAt"`
}
