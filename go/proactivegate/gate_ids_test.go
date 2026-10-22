package proactivegate

import (
	"strconv"
	"strings"
	"testing"
)

// Decision ids are unique per gate instance, so two workers sharing one store
// never share a decision id for the same user, candidate and instant.

func TestSeparateGatesSharingOneStoreEachSpendAUnit(t *testing.T) {
	store := NewMemoryStore()
	now := instant(t, "2026-09-04T09:00:00Z")
	build := func() *Gate {
		return NewGate(GateOptions{Checks: []Check{dailyBudget(budgetOptions{Limit: limitAt(5)})}, Store: store})
	}
	first, second := build(), build()
	in := holdInput("u1", "c1", now)
	one := first.Evaluate(in)
	two := second.Evaluate(in)
	if one.ID == two.ID {
		t.Fatalf("two gates produced the same decision id %q", one.ID)
	}
	if !first.Commit(one, in) {
		t.Fatal("first commit was refused")
	}
	if !second.Commit(two, in) {
		t.Fatal("second commit was refused; it returned the first worker's stored result")
	}
	key, err := budgetKey("u1", now, "Europe/Istanbul")
	if err != nil {
		t.Fatal(err)
	}
	used, ok, err := first.store.Get(key)
	if err != nil || !ok {
		t.Fatalf("budget counter missing: ok=%v err=%v", ok, err)
	}
	if used != "2" {
		t.Fatalf("budget counter = %q, want 2 (one unit per commit)", used)
	}
}

func TestDecisionIDKeepsItsPrefixAndCarriesTheInstanceToken(t *testing.T) {
	g := NewGate(GateOptions{Checks: []Check{dailyBudget(budgetOptions{Limit: limitAt(5)})}})
	now := instant(t, "2026-09-04T09:00:00Z")
	d := g.Evaluate(holdInput("u1", "c1", now))
	prefix, rest, found := strings.Cut(d.ID, "#")
	if !found {
		t.Fatalf("decision id %q has no '#'", d.ID)
	}
	if want := "u1:c1:" + isoMillis(now); prefix != want {
		t.Fatalf("prefix = %q, want %q", prefix, want)
	}
	token, seq, found := strings.Cut(rest, "-")
	if !found {
		t.Fatalf("decision id %q has no token-sequence separator", d.ID)
	}
	if token != g.instance {
		t.Fatalf("token = %q, want the gate's instance token %q", token, g.instance)
	}
	if _, err := strconv.Atoi(seq); err != nil {
		t.Fatalf("sequence %q is not a number: %v", seq, err)
	}
}

func TestEachGateGetsItsOwnInstanceToken(t *testing.T) {
	a := NewGate(GateOptions{})
	b := NewGate(GateOptions{})
	if a.instance == "" || b.instance == "" {
		t.Fatal("a gate has an empty instance token")
	}
	if a.instance == b.instance {
		t.Fatalf("two gates share instance token %q", a.instance)
	}
}

func TestInstanceTokenFallsBackWhenRandomFails(t *testing.T) {
	saved := randRead
	defer func() { randRead = saved }()
	randRead = func([]byte) (int, error) { return 0, strconv.ErrSyntax }
	if token := newInstanceToken(); token == "" {
		t.Fatal("the fallback produced an empty token")
	}
}
