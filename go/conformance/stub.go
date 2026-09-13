package conformance

import (
	"encoding/json"
	"strconv"
	"sync"
	"time"
)

// Stub is a target that fails everything, for proving the runner says so
// precisely: pointed at it, every fixture must report fail with the
// mismatches spelled out, and none may pass or crash.
type Stub struct{}

// Begin accepts every policy; the failure shows up in the decisions, not in
// the plumbing.
func (Stub) Begin(policy json.RawMessage) (Session, error) {
	return &stubSession{store: newStubStore()}, nil
}

type stubSession struct {
	store *stubStore
}

func (s *stubSession) Store() Store { return s.store }

func (s *stubSession) Evaluate(input Input) (*Decision, error) {
	return &Decision{Allowed: false, Reason: "stub: refuses everything"}, nil
}

func (s *stubSession) Commit(d *Decision, input Input) (bool, error) {
	return false, nil
}

// stubStore is the smallest honest Store: a map with TTL support, so a target
// that does nothing else still exercises seeding and store_after reads.
type stubStore struct {
	mu   sync.Mutex
	data map[string]stubEntry
}

type stubEntry struct {
	value     string
	expiresAt int64
	hasExpiry bool
}

func newStubStore() *stubStore {
	return &stubStore{data: map[string]stubEntry{}}
}

func (s *stubStore) live(key string) (stubEntry, bool) {
	entry, ok := s.data[key]
	if !ok {
		return stubEntry{}, false
	}
	if entry.hasExpiry && entry.expiresAt <= time.Now().UnixMilli() {
		delete(s.data, key)
		return stubEntry{}, false
	}
	return entry, true
}

func (s *stubStore) Get(key string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.live(key)
	if !ok {
		return "", false, nil
	}
	return entry.value, true, nil
}

func (s *stubStore) Set(key, value string, ttlSeconds int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := stubEntry{value: value}
	if ttlSeconds > 0 {
		e.expiresAt = time.Now().UnixMilli() + ttlSeconds*1000
		e.hasExpiry = true
	}
	s.data[key] = e
	return nil
}

func (s *stubStore) Incr(key string, ttlSeconds int64) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.live(key)
	var next int64 = 1
	expiresAt, hasExpiry := int64(0), false
	if ttlSeconds > 0 {
		expiresAt, hasExpiry = time.Now().UnixMilli()+ttlSeconds*1000, true
	}
	if ok {
		parsed, err := strconv.ParseInt(current.value, 10, 64)
		if err != nil {
			return 0, err
		}
		next = parsed + 1
		expiresAt, hasExpiry = current.expiresAt, current.hasExpiry
	}
	s.data[key] = stubEntry{value: strconv.FormatInt(next, 10), expiresAt: expiresAt, hasExpiry: hasExpiry}
	return next, nil
}

func (s *stubStore) Del(key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.data, key)
	return nil
}
