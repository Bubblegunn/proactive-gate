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

// atLeast reports whether p is at or above floor. A priority that is not one of the four is below every floor,
// as in the TypeScript and Python packages.
func atLeast(p, floor Priority) bool {
	rp, okP := priorityRank[p]
	rf, okF := priorityRank[floor]
	return okP && okF && rp >= rf
}

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
	ID               string `json:"id"`
	Consent          bool   `json:"consent"`
	ProactiveEnabled *bool  `json:"proactiveEnabled"`
	Mode             string `json:"mode"`
	// SnoozedUntil is an instant (SPEC 9.1.1). It is typed any so that a string, epoch milliseconds or a time.Time all read.
	SnoozedUntil     any             `json:"snoozedUntil"`
	MutedTypes       []string        `json:"mutedTypes"`
	Intensity        string          `json:"intensity"`
	Timezone         string          `json:"timezone"`
	QuietHours       *QuietHours     `json:"quietHours"`
	CreatedAt        any             `json:"createdAt"`
	Surfaces         []string        `json:"surfaces"`
	Consents         map[string]bool `json:"consents"`
	LastInboundAt    any             `json:"lastInboundAt"`
	Minor            bool            `json:"minor"`
	ExistingCustomer bool            `json:"existingCustomer"`

	// The 1.6.0 fields (SPEC 9.1). Absent keeps the 1.5.0 behaviour.

	// DeviceTimezone is the IANA zone the device reports. It wins over Timezone
	// when valid (SPEC 9.2).
	DeviceTimezone string `json:"deviceTimezone"`
	// ConsentUnknown is true when the caller's consent lookup failed (SPEC 9.3).
	ConsentUnknown bool `json:"consentUnknown"`
	// CrisisUntil is the end of a crisis quiet period, or nil (SPEC 9.10).
	CrisisUntil any `json:"crisisUntil"`
	// HourStats maps "0" to "23" to {acted, dismissed} counts. Typed loosely on
	// purpose: a count that is not a number makes that hour's total not finite,
	// and a malformed entry reads as zero (SPEC 9.11).
	HourStats any `json:"hourStats"`
	// Tier names the user's budget tier (SPEC 9.12).
	Tier string `json:"tier"`
	// DailyLimit is an explicit per-user daily budget. It is read only when it
	// is a finite number of at least 0 (SPEC 9.12).
	DailyLimit any `json:"dailyLimit"`
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

	// The 1.6.0 fields (SPEC 9.1).

	// Requested is true when the person asked for this candidate (SPEC 9.5).
	Requested bool `json:"requested"`
	// Kind is "commitment" (something the person set up) or "support" (crisis
	// support). Any other value is an ordinary candidate (SPEC 9.4, 9.10).
	Kind string `json:"kind"`
	// Transactional is true for a receipt or other non-promotional message (SPEC 9.7).
	Transactional bool `json:"transactional"`
	// FreshUntil is an ISO instant after which the candidate is stale. It is
	// typed any so that an unreadable value is read as expired, not as an
	// error (SPEC 9.8).
	FreshUntil any `json:"freshUntil"`
	// CreatedAt is an ISO instant for when the candidate was made (SPEC 9.8).
	CreatedAt any `json:"createdAt"`
	// Evidence is the caller's own account of how well the candidate is founded.
	// The gate never fills it (SPEC 9.9).
	Evidence any `json:"evidence"`
}

// EvaluateInput is one evaluation: a user, a candidate and an instant.
// Now is supplied by the caller in fixtures; in library use a zero Now
// defaults to the current instant.
type EvaluateInput struct {
	User      *UserState
	Candidate *Candidate
	Now       time.Time
	// Flags are operations flags. Every check reads them (SPEC 9.1, 9.13).
	Flags map[string]bool
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
	Flags     map[string]bool
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
	// NextAllowedAt is called only after this check rejected the candidate. It
	// returns the earliest instant at which the check would stop rejecting it,
	// or nil when the check cannot say (SPEC 3.6). It reads no store and never
	// changes a decision; the gate ignores an error, a nil and an instant that
	// is not after Now.
	NextAllowedAt func(ctx *CheckContext) (*time.Time, error)
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
	// NextAllowedAt is the earliest instant at which the check that denied this
	// candidate would stop denying it (SPEC 3.6): the end of quiet hours, the
	// snooze end, or the reset of a daily, weekly or monthly budget. A lower
	// bound, not a promise: a later check can still deny at that instant, so
	// evaluate again then. Nil when allowed, when the denying check cannot say,
	// and when a shadowed check would have denied. For a deferred decision it
	// equals RetryAt.
	NextAllowedAt *time.Time `json:"nextAllowedAt,omitempty"`
	Reason        string     `json:"reason,omitempty"`
	// Shadowed lists the checks in shadow mode that would have stopped the run.
	Shadowed    []string         `json:"shadowed"`
	NearLimit   []NearLimitEntry `json:"nearLimit"`
	Trace       []TraceEntry     `json:"trace"`
	EvaluatedAt time.Time        `json:"evaluatedAt"`
}

// userFields is UserState without its methods, so UnmarshalJSON can decode the rest with the standard rules.
type userFields UserState

// UnmarshalJSON reads ConsentUnknown leniently: only the literal true is true, so a wrong-typed value is not
// true and does not fail the whole decode (D6). Every other field decodes as before.
func (u *UserState) UnmarshalJSON(data []byte) error {
	var aux struct {
		*userFields
		ConsentUnknown json.RawMessage `json:"consentUnknown"`
	}
	aux.userFields = (*userFields)(u)
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	if aux.ConsentUnknown != nil {
		u.ConsentUnknown = isTrueLiteral(aux.ConsentUnknown)
	}
	return nil
}

// candidateFields is Candidate without its methods, for the same reason as userFields.
type candidateFields Candidate

// UnmarshalJSON reads Busy, Requested and Transactional leniently: only the literal true is true, so a
// wrong-typed value is not true and does not fail the whole decode (D6).
func (c *Candidate) UnmarshalJSON(data []byte) error {
	var aux struct {
		*candidateFields
		Busy          json.RawMessage `json:"busy"`
		Requested     json.RawMessage `json:"requested"`
		Transactional json.RawMessage `json:"transactional"`
	}
	aux.candidateFields = (*candidateFields)(c)
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	if aux.Busy != nil {
		c.Busy = isTrueLiteral(aux.Busy)
	}
	if aux.Requested != nil {
		c.Requested = isTrueLiteral(aux.Requested)
	}
	if aux.Transactional != nil {
		c.Transactional = isTrueLiteral(aux.Transactional)
	}
	return nil
}
