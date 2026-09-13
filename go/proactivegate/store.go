package proactivegate

import (
	"strconv"
	"sync"
	"time"
)

// MemoryStore is the in-process store. Correct for one instance; for many
// instances back Store with something whose Incr is atomic across processes.
type MemoryStore struct {
	mu    sync.Mutex
	data  map[string]memoryEntry
	clock func() int64 // unix milliseconds; injectable for tests
}

type memoryEntry struct {
	value     string
	expiresAt int64 // unix milliseconds; 0 means no expiry
	hasExpiry bool
}

// NewMemoryStore returns a store expiring keys against the wall clock.
func NewMemoryStore() *MemoryStore {
	return &MemoryStore{data: map[string]memoryEntry{}, clock: func() int64 { return time.Now().UnixMilli() }}
}

// NewMemoryStoreClock returns a store expiring keys against clock, so tests
// can move time without waiting.
func NewMemoryStoreClock(clock func() int64) *MemoryStore {
	return &MemoryStore{data: map[string]memoryEntry{}, clock: clock}
}

// live returns the entry when it exists and has not expired, pruning it when
// it has. Callers must hold mu.
func (s *MemoryStore) live(key string) (memoryEntry, bool) {
	entry, ok := s.data[key]
	if !ok {
		return memoryEntry{}, false
	}
	if entry.hasExpiry && entry.expiresAt <= s.clock() {
		delete(s.data, key)
		return memoryEntry{}, false
	}
	return entry, true
}

func (s *MemoryStore) Get(key string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.live(key)
	if !ok {
		return "", false, nil
	}
	return entry.value, true, nil
}

func (s *MemoryStore) Set(key, value string, ttlSeconds int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data[key] = memoryEntry{value: value, expiresAt: expiry(s.clock, ttlSeconds), hasExpiry: ttlSeconds > 0}
	return nil
}

// Incr is atomic under mu. The TTL is attached on the first increment only:
// incrementing an existing key keeps its original expiry (5.8).
func (s *MemoryStore) Incr(key string, ttlSeconds int64) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.live(key)
	var next int64 = 1
	expiresAt, hasExpiry := expiry(s.clock, ttlSeconds), ttlSeconds > 0
	if ok {
		parsed, err := strconv.ParseInt(current.value, 10, 64)
		if err != nil {
			return 0, err
		}
		next = parsed + 1
		expiresAt, hasExpiry = current.expiresAt, current.hasExpiry
	}
	s.data[key] = memoryEntry{value: strconv.FormatInt(next, 10), expiresAt: expiresAt, hasExpiry: hasExpiry}
	return next, nil
}

func (s *MemoryStore) Del(key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.data, key)
	return nil
}

func expiry(clock func() int64, ttlSeconds int64) int64 {
	if ttlSeconds <= 0 {
		return 0
	}
	return clock() + ttlSeconds*1000
}

// prefixedStore applies the policy's key prefix to every key the gate writes,
// so "budget:u1:2026-09-04" lives in the store as "pg:budget:u1:2026-09-04".
type prefixedStore struct {
	inner  Store
	prefix string
}

func (p prefixedStore) Get(key string) (string, bool, error) { return p.inner.Get(p.prefix + key) }
func (p prefixedStore) Set(key, value string, ttlSeconds int64) error {
	return p.inner.Set(p.prefix+key, value, ttlSeconds)
}
func (p prefixedStore) Incr(key string, ttlSeconds int64) (int64, error) {
	return p.inner.Incr(p.prefix+key, ttlSeconds)
}
func (p prefixedStore) Del(key string) error { return p.inner.Del(p.prefix + key) }
