package proactivegate

import (
	"encoding/json"
	"math"
	"strconv"
	"testing"
	"time"
)

// Review round 3 (R1 to R4, D2, D5, D6). These tests are built from Go values, not decoded JSON, because
// the review found that the Go-built shapes were the ones that broke (Candidate.FreshUntil as time.Time,
// UserState.DailyLimit as int, evidence as map[string]int). The JSON cases are kept where the decoder is the thing under test.

var r3Now = "2026-09-04T12:00:00Z"

func r3Decide(t *testing.T, checks []Check, in EvaluateInput) *Decision {
	t.Helper()
	return NewGate(GateOptions{Checks: checks, Store: NewMemoryStore()}).Evaluate(in)
}

func r3Input(t *testing.T, c *Candidate) EvaluateInput {
	return EvaluateInput{User: &UserState{ID: "u1", Consent: true}, Candidate: c, Now: instant(t, r3Now)}
}

// R1: a nil or zero instant is absent, so freshness skips.

func TestR1AZeroTimeInstantIsAbsentAndFreshnessSkips(t *testing.T) {
	d := r3Decide(t, []Check{freshness(nil)}, r3Input(t, &Candidate{ID: "c1", Type: "insight", FreshUntil: time.Time{}}))
	if !d.Allowed || d.Trace[0].Outcome != OutcomeSkip {
		t.Fatalf("zero time.Time freshUntil: allowed=%v rejectedBy=%q reason=%q; want skip", d.Allowed, d.RejectedBy, d.Reason)
	}
}

// R4: every instant kind the spec names reads the same way.

func TestR4ATimeTimeInstantIsRead(t *testing.T) {
	now := instant(t, r3Now)
	fresh := r3Decide(t, []Check{freshness(nil)}, r3Input(t, &Candidate{ID: "c1", Type: "insight", FreshUntil: now.Add(time.Hour)}))
	if !fresh.Allowed {
		t.Fatalf("time.Time an hour ahead refused: rejectedBy %q, reason %q", fresh.RejectedBy, fresh.Reason)
	}
	stale := r3Decide(t, []Check{freshness(nil)}, r3Input(t, &Candidate{ID: "c1", Type: "insight", FreshUntil: now}))
	if stale.RejectedBy != "freshness" {
		t.Fatalf("time.Time equal to now: rejectedBy %q, want freshness (equal to now is expired)", stale.RejectedBy)
	}
}

func TestR4AnOffsetLessInstantIsUTCWhateverTheHostZone(t *testing.T) {
	d := r3Decide(t, []Check{freshness(nil)}, r3Input(t, &Candidate{ID: "c1", Type: "insight", FreshUntil: "2026-09-04T12:00:01"}))
	if !d.Allowed {
		t.Fatalf("offset-less 12:00:01 read as UTC is fresh at 12:00:00Z: rejectedBy %q, reason %q", d.RejectedBy, d.Reason)
	}
}

func TestR4ADateAloneIsMidnightUTC(t *testing.T) {
	expired := r3Decide(t, []Check{freshness(nil)}, r3Input(t, &Candidate{ID: "c1", Type: "insight", FreshUntil: "2026-09-04"}))
	if expired.RejectedBy != "freshness" {
		t.Fatalf("\"2026-09-04\" is 00:00Z, expired at 12:00Z: rejectedBy %q", expired.RejectedBy)
	}
	fresh := r3Decide(t, []Check{freshness(nil)}, r3Input(t, &Candidate{ID: "c1", Type: "insight", FreshUntil: "2026-09-05"}))
	if !fresh.Allowed {
		t.Fatalf("\"2026-09-05\" is fresh at 12:00Z on 4 Sep: rejectedBy %q", fresh.RejectedBy)
	}
}

func TestR4AnEpochInMillisecondsIsAnInstantOfAnyNumericKind(t *testing.T) {
	ahead := instant(t, r3Now).Add(time.Hour).UnixMilli()
	for name, v := range map[string]any{"float64": float64(ahead), "int64": ahead, "int": int(ahead), "json.Number": json.Number("1793000000000")} {
		d := r3Decide(t, []Check{freshness(nil)}, r3Input(t, &Candidate{ID: "c1", Type: "insight", FreshUntil: v}))
		if name == "json.Number" {
			// 1793000000000 is 2026-10-... in ms; a fixed far-future epoch must be fresh.
			if !d.Allowed {
				t.Fatalf("%s epoch refused: rejectedBy %q reason %q", name, d.RejectedBy, d.Reason)
			}
			continue
		}
		if !d.Allowed {
			t.Fatalf("%s epoch %v refused: rejectedBy %q reason %q", name, v, d.RejectedBy, d.Reason)
		}
	}
}

// R2: an evidence count that is not a finite number is zero, and the int kinds are numbers.

func TestR2AnIntEvidenceCountIsReadNotIgnored(t *testing.T) {
	for name, evidence := range map[string]any{
		"map[string]any int":     map[string]any{"dataPoints": 3, "confidence": 0.9},
		"map[string]any int64":   map[string]any{"dataPoints": int64(3), "confidence": 0.9},
		"map[string]any float64": map[string]any{"dataPoints": 3.0, "confidence": 0.9},
		"json.Number":            map[string]any{"dataPoints": json.Number("3"), "confidence": 0.9},
	} {
		d := r3Decide(t, []Check{silence(5, 0.5, true)}, r3Input(t, &Candidate{ID: "c1", Type: "insight", Evidence: evidence}))
		if d.RejectedBy != "silence" {
			t.Fatalf("%s: 3 data points against a minimum of 5 gave rejectedBy %q; want silence", name, d.RejectedBy)
		}
	}
}

func TestR2ATypedEvidenceMapIsRead(t *testing.T) {
	d := r3Decide(t, []Check{silence(5, 0.5, true)}, r3Input(t, &Candidate{ID: "c1", Type: "insight", Evidence: map[string]int{"dataPoints": 9, "confidence": 1}}))
	if !d.Allowed {
		t.Fatalf("map[string]int with 9 data points refused: rejectedBy %q reason %q", d.RejectedBy, d.Reason)
	}
}

func TestR2AStringOrNonFiniteCountIsZeroAndRefuses(t *testing.T) {
	cases := map[string]map[string]any{
		"string 9":          {"dataPoints": "9", "confidence": 0.9},
		"+Inf":              {"dataPoints": math.Inf(1), "confidence": 0.9},
		"NaN":               {"dataPoints": math.NaN(), "confidence": 0.9},
		"bool true":         {"dataPoints": true, "confidence": 0.9},
		"string confidence": {"dataPoints": 9.0, "confidence": "0.9"},
	}
	for name, evidence := range cases {
		d := r3Decide(t, []Check{silence(5, 0.5, true)}, r3Input(t, &Candidate{ID: "c1", Type: "insight", Evidence: evidence}))
		if d.RejectedBy != "silence" {
			t.Fatalf("%s: rejectedBy %q, want silence (a non-number counts as zero)", name, d.RejectedBy)
		}
	}
}

// R2 also reaches the budget tiers and the explicit daily override, which read Go-built ints.

func TestR2ADailyLimitAsAGoIntIsTheOverride(t *testing.T) {
	store := NewMemoryStore()
	g := NewGate(GateOptions{Checks: []Check{dailyBudget(budgetOptions{Limit: limitAt(5)})}, Store: store})
	user := &UserState{ID: "u1", Consent: true, Timezone: "UTC", DailyLimit: 2}
	in := EvaluateInput{User: user, Candidate: &Candidate{ID: "c1", Type: "insight"}, Now: instant(t, r3Now)}
	for i := 0; i < 2; i++ {
		d := g.Evaluate(in)
		if !d.Allowed {
			t.Fatalf("delivery %d refused under a limit of 2: %q", i+1, d.Reason)
		}
		if !g.Commit(d, in) {
			t.Fatalf("commit %d refused", i+1)
		}
	}
	if d := g.Evaluate(in); d.Allowed {
		t.Fatal("a third delivery allowed; the Go int dailyLimit 2 was ignored and the own limit 5 applied")
	}
}

// D5: a null or a non-boolean flag is not false, so it stops nothing. D6: a wrong-typed boolean is not true.

func TestD5ANullOrNonBooleanFlagStopsNothing(t *testing.T) {
	flags, err := decodeFlags(json.RawMessage(`{"x": null, "y": "no", "z": 0}`))
	if err != nil {
		t.Fatalf("decodeFlags failed on a null or non-boolean flag: %v", err)
	}
	for _, name := range []string{"x", "y", "z", "absent"} {
		d := r3Decide(t, []Check{killSwitchFlag(name)}, EvaluateInput{User: &UserState{ID: "u1", Consent: true}, Candidate: &Candidate{ID: "c1", Type: "insight"}, Now: instant(t, r3Now), Flags: flags})
		if !d.Allowed {
			t.Fatalf("flag %q stopped the gate (rejectedBy %q); only exactly false stops it", name, d.RejectedBy)
		}
	}
}

func TestD5ANilFlagsMapStopsNothing(t *testing.T) {
	d := r3Decide(t, []Check{killSwitchFlag("x")}, EvaluateInput{User: &UserState{ID: "u1", Consent: true}, Candidate: &Candidate{ID: "c1", Type: "insight"}, Now: instant(t, r3Now)})
	if !d.Allowed {
		t.Fatalf("a nil flags map stopped the gate: %q", d.Reason)
	}
}

func TestD6AWrongTypedBooleanIsNotTrueAndDoesNotFailTheDecode(t *testing.T) {
	var c Candidate
	if err := json.Unmarshal([]byte(`{"id":"c1","type":"insight","requested":"yes","transactional":"true","busy":1}`), &c); err != nil {
		t.Fatalf("a wrong-typed boolean failed the decode: %v", err)
	}
	if c.Requested || c.Transactional || c.Busy {
		t.Fatalf("wrong-typed booleans read as true: requested=%v transactional=%v busy=%v", c.Requested, c.Transactional, c.Busy)
	}
	var literal Candidate
	if err := json.Unmarshal([]byte(`{"id":"c1","type":"insight","requested":true}`), &literal); err != nil || !literal.Requested {
		t.Fatalf("the literal true must still read as true: err=%v requested=%v", err, literal.Requested)
	}
	var u UserState
	if err := json.Unmarshal([]byte(`{"id":"u1","consentUnknown":"true"}`), &u); err != nil || u.ConsentUnknown {
		t.Fatalf("consentUnknown \"true\" read as true or failed the decode: err=%v value=%v", err, u.ConsentUnknown)
	}
}

// D2: an explicit limit of 0 allows nothing, as it does in TypeScript and Python.

func TestD2ARateLimitWithLimitZeroAllowsNothing(t *testing.T) {
	check, err := knownChecks["rateLimit"](options{"limit": float64(0), "perSeconds": float64(60)})
	if err != nil {
		t.Fatal(err)
	}
	d := r3Decide(t, []Check{check}, r3Input(t, &Candidate{ID: "c1", Type: "insight"}))
	if d.Allowed {
		t.Fatal("rateLimit with limit 0 allowed a delivery; it should allow nothing")
	}
}

func TestD2AWindowBudgetWithLimitZeroAllowsNothing(t *testing.T) {
	inbound := "2026-09-04T11:00:00Z"
	check, err := knownChecks["windowBudget"](options{"limit": float64(0), "withinHours": float64(24)})
	if err != nil {
		t.Fatal(err)
	}
	d := r3Decide(t, []Check{check}, EvaluateInput{User: &UserState{ID: "u1", Consent: true, LastInboundAt: &inbound}, Candidate: &Candidate{ID: "c1", Type: "insight"}, Now: instant(t, r3Now)})
	if d.Allowed {
		t.Fatal("windowBudget with limit 0 allowed a delivery; it should allow nothing")
	}
}

// Record returns an error on an absent user or candidate; it does not panic.

func TestRecordReturnsAnErrorForAnAbsentUserOrDismissedCandidate(t *testing.T) {
	g := NewGate(GateOptions{Checks: nil, Store: NewMemoryStore()})
	at := instant(t, r3Now)
	cand := &Candidate{ID: "c1", Type: "insight"}
	user := &UserState{ID: "u1", Consent: true}
	cases := map[string]func() error{
		"nil user":                func() error { return g.Record(nil, cand, "acted", at) },
		"nil candidate dismissed": func() error { return g.Record(user, nil, "dismissed", at) },
	}
	for name, call := range cases {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("%s panicked: %v", name, r)
				}
			}()
			if err := call(); err == nil {
				t.Fatalf("%s returned no error", name)
			}
		}()
	}
	if err := g.Record(user, nil, "acted", at); err != nil {
		t.Fatalf("an acted event does not read the candidate, so a nil candidate is fine: %v", err)
	}
}

// Priority: an unknown priority is below every floor, as in TypeScript and Python.

func TestAnUnknownPriorityIsBelowEveryFloor(t *testing.T) {
	for _, floor := range []Priority{PriorityLow, PriorityNormal, PriorityHigh, PriorityCritical} {
		if atLeast(Priority("urgent"), floor) {
			t.Fatalf("an unknown priority is at or above the floor %q", floor)
		}
	}
	if !atLeast(PriorityHigh, PriorityLow) {
		t.Fatal("a known priority is not above a lower floor")
	}
}

// R2 also reaches a count inside hourStats and a budget tier, which Go callers write as int.

func TestR2AnIntHourStatsCountIsReadSoADeadHourIsJudged(t *testing.T) {
	now := instant(t, r3Now)
	hour := hourOfDay(now, "UTC")
	g := NewGate(GateOptions{Checks: []Check{deadHours(5, 0.2, PriorityHigh)}, Store: NewMemoryStore()})
	in := EvaluateInput{
		User:      &UserState{ID: "u1", Consent: true, Timezone: "UTC", HourStats: map[string]any{strconv.Itoa(hour): map[string]any{"acted": 1, "dismissed": 9}}},
		Candidate: &Candidate{ID: "c1", Type: "reminder", Surfaces: []string{"push", "feed"}},
		Now:       now,
	}
	d := g.Evaluate(in)
	if !d.Allowed || len(d.Surfaces) != 1 || d.Surfaces[0] != "feed" {
		t.Fatalf("surfaces %v; 1 acted of 10 with int counts is a dead hour, so push must go", d.Surfaces)
	}
}

func TestR2ATierLimitAsAGoIntIsTheLimit(t *testing.T) {
	store := NewMemoryStore()
	g := NewGate(GateOptions{Checks: []Check{dailyBudget(budgetOptions{Limit: limitAt(5), Tiers: map[string]any{"pro": 2}})}, Store: store})
	user := &UserState{ID: "u1", Consent: true, Timezone: "UTC", Tier: "pro"}
	in := EvaluateInput{User: user, Candidate: &Candidate{ID: "c1", Type: "insight"}, Now: instant(t, r3Now)}
	for i := 0; i < 2; i++ {
		d := g.Evaluate(in)
		if !d.Allowed || !g.Commit(d, in) {
			t.Fatalf("delivery %d refused under the tier limit 2: %q", i+1, d.Reason)
		}
	}
	if d := g.Evaluate(in); d.Allowed {
		t.Fatal("a third delivery allowed; the Go int tier limit 2 was ignored")
	}
}
