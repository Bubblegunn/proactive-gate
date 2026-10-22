package proactivegate

import (
	"testing"
	"time"
)

// R4: the user's instant fields accept a time.Time as the candidate's do. Kept in its own file so the rest of the
// round-3 tests compile while the field types are still *string.

func TestR4AUserInstantAcceptsATimeTime(t *testing.T) {
	now := instant(t, r3Now)
	g := NewGate(GateOptions{Checks: []Check{crisisQuiet()}})
	d := g.Evaluate(EvaluateInput{User: &UserState{ID: "u1", Consent: true, CrisisUntil: now.Add(time.Hour)}, Candidate: &Candidate{ID: "c1", Type: "insight"}, Now: now})
	if d.RejectedBy != "crisisQuiet" {
		t.Fatalf("crisisUntil as time.Time an hour ahead: rejectedBy %q, want crisisQuiet", d.RejectedBy)
	}
}
