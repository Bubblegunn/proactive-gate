package proactivegate

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The 1.6.0 fixtures under spec/fixtures/lessons say what the answer is. These
// tests cover what they do not: the edge cases the specification names and the
// fixtures leave open.

func TestAnInvalidDeviceZoneIsIgnoredAsIfAbsent(t *testing.T) {
	profile := "Europe/Istanbul"
	user := &UserState{ID: "u1", Timezone: profile, DeviceTimezone: "Mars/Olympus"}
	if got := effectiveZone(user); got != profile {
		t.Fatalf("effective zone = %q, want the profile zone %q when the device zone is not a zone", got, profile)
	}
	none := &UserState{ID: "u2", DeviceTimezone: "Mars/Olympus"}
	if got := effectiveZone(none); got != "" {
		t.Fatalf("effective zone = %q, want none when neither zone is valid", got)
	}
}

func TestConsentUnknownWithNoFailModeClosesEverySurface(t *testing.T) {
	g := NewGate(GateOptions{Checks: []Check{consent(nil)}})
	in := EvaluateInput{
		User:      &UserState{ID: "u1", Consent: true, ConsentUnknown: true},
		Candidate: &Candidate{ID: "c1", Type: "reminder", Surfaces: []string{"push", "feed"}},
		Now:       instant(t, "2026-09-04T12:00:00Z"),
	}
	d := g.Evaluate(in)
	if d.Allowed {
		t.Fatalf("allowed with consent unknown and no failMode; surfaces %v", d.Surfaces)
	}
	if d.RejectedBy != "consent" || !strings.Contains(d.Reason, "could not be determined") {
		t.Fatalf("rejectedBy %q, reason %q; want consent refused as could not be determined", d.RejectedBy, d.Reason)
	}
}

func TestACommitmentSpendsNoBudgetUnit(t *testing.T) {
	store := NewMemoryStore()
	policy := []Check{mute(), dailyBudget(budgetOptions{Limit: limitAt(1)}), monthlyBudget(budgetOptions{Limit: limitAt(1)})}
	g := NewGate(GateOptions{Checks: policy, Store: store})
	now := instant(t, "2026-09-04T12:00:00Z")
	in := EvaluateInput{
		User:      &UserState{ID: "u1", Consent: true, Timezone: "Europe/Istanbul", MutedTypes: []string{"reminder"}},
		Candidate: &Candidate{ID: "c1", Type: "reminder", Kind: "commitment"},
		Now:       now,
	}
	d := g.Evaluate(in)
	if !d.Allowed {
		t.Fatalf("commitment refused: rejectedBy %q, reason %q", d.RejectedBy, d.Reason)
	}
	if !g.Commit(d, in) {
		t.Fatal("commit of a commitment was refused")
	}
	for _, key := range []string{"budget:u1:2026-09-04", "monthlyBudget:u1:2026-09"} {
		if _, ok, _ := g.InnerStore().Get("pg:" + key); ok {
			t.Fatalf("commit wrote %s; a commitment must spend nothing", key)
		}
	}
}

func TestAQuietHoursPolicyRefusesAnUnknownMissingTimezoneValue(t *testing.T) {
	for _, value := range []string{`"warn"`, `""`, `true`, `null`} {
		policy := `{"specVersion":"1.0.0","checks":[{"id":"quietHours","onMissingTimezone":` + value + `}]}`
		var p Policy
		if err := json.Unmarshal([]byte(policy), &p); err != nil {
			t.Fatal(err)
		}
		if _, err := CompilePolicy(&p); err == nil {
			t.Fatalf("onMissingTimezone %s compiled; it must be refused, not read as skip", value)
		}
	}
}

func TestAMalformedHourStatsEntryCountsAsZeroAndOverridesTheStore(t *testing.T) {
	store := NewMemoryStore()
	now := instant(t, "2026-09-04T12:00:00Z")
	hour := hourOfDay(now, "Europe/Istanbul")
	// The stored counters say this hour is dead; the caller's entry is not an object.
	if err := store.Set("pg:"+hoursKey("u1", hour, "dismissed"), "9", 0); err != nil {
		t.Fatal(err)
	}
	g := NewGate(GateOptions{Checks: []Check{deadHours(5, 0.2, PriorityHigh)}, Store: store})
	in := EvaluateInput{
		User: &UserState{
			ID: "u1", Consent: true, Timezone: "Europe/Istanbul",
			HourStats: map[string]any{strconv.Itoa(hour): "bad"},
		},
		Candidate: &Candidate{ID: "c1", Type: "reminder", Surfaces: []string{"push", "feed"}},
		Now:       now,
	}
	d := g.Evaluate(in)
	if !d.Allowed || !sameSurfaces(d.Surfaces, []string{"push", "feed"}) {
		t.Fatalf("surfaces %v; a malformed entry counts as zero, so the stored dead hour must not decide", d.Surfaces)
	}
}

func TestRecordCountsActedAndDismissedInTheLocalHourAndNothingElse(t *testing.T) {
	store := NewMemoryStore()
	g := NewGate(GateOptions{Store: store})
	at := instant(t, "2026-09-04T09:30:00Z")
	user := &UserState{ID: "u1", DeviceTimezone: "Europe/Istanbul"}
	cand := &Candidate{ID: "c1", Type: "reminder"}
	hour := hourOfDay(at, effectiveZone(user))

	for _, event := range []string{"delivered", "ignored"} {
		if err := g.Record(user, cand, event, at); err != nil {
			t.Fatal(err)
		}
	}
	if _, ok, _ := store.Get("pg:" + hoursKey("u1", hour, "acted")); ok {
		t.Fatal("delivered or ignored wrote an hour counter")
	}
	if err := g.Record(user, cand, "acted", at); err != nil {
		t.Fatal(err)
	}
	raw, ok, _ := store.Get("pg:" + hoursKey("u1", hour, "acted"))
	if !ok || raw != "1" {
		t.Fatalf("acted counter at the local hour %d = %q (present %v), want 1", hour, raw, ok)
	}
	if _, ok, _ := store.Get("pg:" + dismissalKey("u1", "reminder")); ok {
		t.Fatal("acted wrote a dismissal; only dismissed does")
	}
}

func TestSilenceAcceptsNothingNewOnlyWhenNothingNewIsNotRequired(t *testing.T) {
	g := NewGate(GateOptions{Checks: []Check{silence(5, 0.5, false)}})
	in := EvaluateInput{
		User:      &UserState{ID: "u1", Consent: true},
		Candidate: &Candidate{ID: "c1", Type: "insight", Evidence: map[string]any{"dataPoints": 10.0, "confidence": 0.9, "newSinceLast": false}},
		Now:       instant(t, "2026-09-04T12:00:00Z"),
	}
	if d := g.Evaluate(in); !d.Allowed {
		t.Fatalf("requireNew false still refused: %q", d.Reason)
	}
}

func TestSilenceTreatsAnAbsentNewSinceLastAsNotNothingNew(t *testing.T) {
	g := NewGate(GateOptions{Checks: []Check{silence(5, 0.5, true)}})
	in := EvaluateInput{
		User:      &UserState{ID: "u1", Consent: true},
		Candidate: &Candidate{ID: "c1", Type: "insight", Evidence: map[string]any{"dataPoints": 10.0, "confidence": 0.9}},
		Now:       instant(t, "2026-09-04T12:00:00Z"),
	}
	if d := g.Evaluate(in); !d.Allowed {
		t.Fatalf("an absent newSinceLast refused as nothing new: %q", d.Reason)
	}
}

func TestAStringDailyLimitIsNoOverride(t *testing.T) {
	store := NewMemoryStore()
	now := instant(t, "2026-09-04T12:00:00Z")
	key, err := budgetKey("u1", now, "")
	if err != nil {
		t.Fatal(err)
	}
	// Two units are spent, so the check's own limit of 2 is reached. A string
	// "5" must not be read as an override that makes room.
	for i := 0; i < 2; i++ {
		if _, err := store.Incr("pg:"+key, 0); err != nil {
			t.Fatal(err)
		}
	}
	g := NewGate(GateOptions{Checks: []Check{dailyBudget(budgetOptions{Limit: limitAt(2)})}, Store: store})
	in := EvaluateInput{
		User:      &UserState{ID: "u1", Consent: true, DailyLimit: "5"},
		Candidate: &Candidate{ID: "c1", Type: "insight"},
		Now:       now,
	}
	if d := g.Evaluate(in); d.Allowed {
		t.Fatal("a string dailyLimit was read as an override; the check's own limit of 2 must refuse")
	}
	in.User.DailyLimit = 5.0
	if d := g.Evaluate(in); !d.Allowed {
		t.Fatalf("a numeric dailyLimit of 5 did not override: %q", d.Reason)
	}
}

func TestAnExplicitZeroBudgetLimitAllowsNothing(t *testing.T) {
	var p Policy
	if err := json.Unmarshal([]byte(`{"specVersion":"1.0.0","checks":[{"id":"dailyBudget","limit":0}]}`), &p); err != nil {
		t.Fatal(err)
	}
	g, err := NewGateFromPolicy(&p, NewMemoryStore())
	if err != nil {
		t.Fatal(err)
	}
	in := EvaluateInput{
		User:      &UserState{ID: "u1", Consent: true},
		Candidate: &Candidate{ID: "c1", Type: "insight"},
		Now:       instant(t, "2026-09-04T12:00:00Z"),
	}
	if d := g.Evaluate(in); d.Allowed {
		t.Fatal("a limit of 0 allowed a delivery; an explicit zero is a limit, not the default")
	}
}

func TestKillSwitchTakesEitherTheOnFormOrTheFlagFormNotBoth(t *testing.T) {
	for _, text := range []string{
		`{"id":"killSwitch","on":true,"flag":"proactiveEnabled"}`,
		`{"id":"killSwitch","flag":1}`,
	} {
		var p Policy
		if err := json.Unmarshal([]byte(`{"specVersion":"1.0.0","checks":[`+text+`]}`), &p); err != nil {
			t.Fatal(err)
		}
		if _, err := CompilePolicy(&p); err == nil {
			t.Fatalf("%s compiled; the kill switch takes on or a string flag, not both or neither", text)
		}
	}
}

func TestAFlagThatIsNotFalseStopsNothing(t *testing.T) {
	g := NewGate(GateOptions{Checks: []Check{killSwitchFlag("proactiveEnabled")}})
	base := EvaluateInput{
		User:      &UserState{ID: "u1", Consent: true},
		Candidate: &Candidate{ID: "c1", Type: "insight"},
		Now:       instant(t, "2026-09-04T12:00:00Z"),
	}
	for name, flags := range map[string]map[string]bool{"true": {"proactiveEnabled": true}, "absent": nil} {
		in := base
		in.Flags = flags
		if d := g.Evaluate(in); !d.Allowed {
			t.Fatalf("the %s flag stopped the kill switch: %q", name, d.Reason)
		}
	}
}

func sameSurfaces(a, b []string) bool {
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

// assistantNudgeGate compiles the preset with the given options, as a JSON
// policy names it.
func assistantNudgeGate(t *testing.T, store Store, options string) *Gate {
	t.Helper()
	var p Policy
	text := `{"specVersion":"1.0.0","checks":[{"preset":"assistantNudge"` + options + `}]}`
	if err := json.Unmarshal([]byte(text), &p); err != nil {
		t.Fatal(err)
	}
	g, err := NewGateFromPolicy(&p, store)
	if err != nil {
		t.Fatal(err)
	}
	return g
}

func TestACommitmentThroughTheWholeAssistantNudgeSpendsNothing(t *testing.T) {
	store := NewMemoryStore()
	now := instant(t, "2026-09-04T12:00:00Z")
	key, err := budgetKey("u1", now, "Europe/Istanbul")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Incr("pg:"+key, 0); err != nil {
		t.Fatal(err)
	}
	g := assistantNudgeGate(t, store, `,"dailyLimit":1`)
	in := EvaluateInput{
		User: &UserState{
			ID: "u1", Consent: true, Timezone: "Europe/Istanbul",
			CreatedAt: strPtr("2026-09-03T12:00:00Z"),
		},
		Candidate: &Candidate{ID: "c1", Type: "reminder", Kind: "commitment", Surfaces: []string{"feed"}},
		Now:       now,
		Flags:     map[string]bool{"proactiveEnabled": true},
	}
	d := g.Evaluate(in)
	if !d.Allowed {
		t.Fatalf("commitment held by %s: %q", d.RejectedBy, d.Reason)
	}
	if !g.Commit(d, in) {
		t.Fatal("commit of the commitment was refused")
	}
	raw, ok, _ := store.Get("pg:" + key)
	if !ok || raw != "1" {
		t.Fatalf("daily counter = %q (present %v) after commit, want the seeded 1", raw, ok)
	}
}

func TestTheAssistantNudgeDailyLimitIsTheBudgetAndACandidateOverItIsRefused(t *testing.T) {
	store := NewMemoryStore()
	now := instant(t, "2026-09-04T12:00:00Z")
	key, err := budgetKey("u1", now, "Europe/Istanbul")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Incr("pg:"+key, 0); err != nil {
		t.Fatal(err)
	}
	g := assistantNudgeGate(t, store, `,"dailyLimit":1`)
	in := EvaluateInput{
		User: &UserState{
			ID: "u1", Consent: true, Timezone: "Europe/Istanbul",
			CreatedAt: strPtr("2026-07-01T12:00:00Z"), Consents: map[string]bool{"marketing": true},
		},
		Candidate: &Candidate{ID: "c1", Type: "insight", Surfaces: []string{"feed"}},
		Now:       now,
		Flags:     map[string]bool{"proactiveEnabled": true},
	}
	d := g.Evaluate(in)
	if d.Allowed || d.RejectedBy != "dailyBudget" {
		t.Fatalf("allowed %v, rejectedBy %q; a dailyLimit of 1 with one used must refuse at dailyBudget", d.Allowed, d.RejectedBy)
	}
}

func TestTheAssistantNudgeExemptTypesAreNotSilencedByTheCooldown(t *testing.T) {
	store := NewMemoryStore()
	g := assistantNudgeGate(t, store, `,"exemptTypes":["digest"]`)
	now := instant(t, "2026-09-04T12:00:00Z")
	user := &UserState{ID: "u1", Consent: true, Timezone: "Europe/Istanbul", CreatedAt: strPtr("2026-07-01T12:00:00Z"), Consents: map[string]bool{"marketing": true}}
	for _, typ := range []string{"digest", "reminder"} {
		for i := 0; i < 3; i++ {
			if err := g.Record(user, &Candidate{ID: "d", Type: typ}, "dismissed", now.Add(-time.Duration(i+1)*time.Hour)); err != nil {
				t.Fatal(err)
			}
		}
	}
	probe := func(typ string) *Decision {
		return g.Evaluate(EvaluateInput{
			User:      user,
			Candidate: &Candidate{ID: "c", Type: typ, Surfaces: []string{"feed"}},
			Now:       now,
			Flags:     map[string]bool{"proactiveEnabled": true},
		})
	}
	if d := probe("digest"); !d.Allowed {
		t.Fatalf("an exempt type was silenced by %s: %q", d.RejectedBy, d.Reason)
	}
	if d := probe("reminder"); d.Allowed || d.RejectedBy != "dismissalCooldown" {
		t.Fatalf("an unlisted type after three dismissals: allowed %v, rejectedBy %q; want the cooldown to refuse", d.Allowed, d.RejectedBy)
	}
}

func TestTheAssistantNudgeRefusesABadDailyLimitOrExemptTypes(t *testing.T) {
	for _, options := range []string{`,"dailyLimit":-1`, `,"dailyLimit":"3"`, `,"exemptTypes":"digest"`, `,"exemptTypes":[1]`} {
		var p Policy
		text := `{"specVersion":"1.0.0","checks":[{"preset":"assistantNudge"` + options + `}]}`
		if err := json.Unmarshal([]byte(text), &p); err != nil {
			t.Fatal(err)
		}
		if _, err := CompilePolicy(&p); err == nil {
			t.Fatalf("assistantNudge with %s compiled; it must be refused", options)
		}
	}
}

func strPtr(s string) *string { return &s }
