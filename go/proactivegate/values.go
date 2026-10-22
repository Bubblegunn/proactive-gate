package proactivegate

import (
	"bytes"
	"encoding/json"
	"math"
	"reflect"
	"regexp"
	"strconv"
	"time"
)

// This file holds the readers for values a caller may supply either as decoded JSON or as Go values. A
// JSON number decodes as float64, but a Go caller writes int, int64, json.Number or a time.Time, and each
// must read the same way (SPEC 9.1, 9.1.1, 9.9).

// numberOf reads a number of any Go numeric kind or a json.Number. Booleans and strings are not numbers.
func numberOf(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case float32:
		return float64(x), true
	case int:
		return float64(x), true
	case int8:
		return float64(x), true
	case int16:
		return float64(x), true
	case int32:
		return float64(x), true
	case int64:
		return float64(x), true
	case uint:
		return float64(x), true
	case uint8:
		return float64(x), true
	case uint16:
		return float64(x), true
	case uint32:
		return float64(x), true
	case uint64:
		return float64(x), true
	case json.Number:
		n, err := strconv.ParseFloat(string(x), 64)
		return n, err == nil
	}
	return 0, false
}

// evidenceCount reads a count the caller supplied as evidence (SPEC 9.9): a finite number, else zero. A string
// is not a number, even "9", so it counts as zero and a silence check refuses on it.
func evidenceCount(v any) float64 {
	n, ok := numberOf(v)
	if !ok || math.IsNaN(n) || math.IsInf(n, 0) {
		return 0
	}
	return n
}

// fieldOf reads one key of an object the caller supplied: a map[string]any, or any map keyed by string. An absent
// key, or an object that is not a map, reads as nil.
func fieldOf(object any, key string) any {
	if m, ok := object.(map[string]any); ok {
		return m[key]
	}
	rv := reflect.ValueOf(object)
	if rv.Kind() != reflect.Map || rv.Type().Key().Kind() != reflect.String {
		return nil
	}
	v := rv.MapIndex(reflect.ValueOf(key).Convert(rv.Type().Key()))
	if !v.IsValid() {
		return nil
	}
	return v.Interface()
}

// isTrueLiteral reports whether a raw JSON value is the literal true. Anything else, including a string "true",
// null, or a number, is not true (SPEC 9.5, 9.7; D6).
func isTrueLiteral(raw json.RawMessage) bool {
	return string(bytes.TrimSpace(raw)) == "true"
}

// isFalseLiteral reports whether a raw JSON value is the literal false.
func isFalseLiteral(raw json.RawMessage) bool {
	return string(bytes.TrimSpace(raw)) == "false"
}

var (
	offsetlessInstant = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$`)
	dateOnlyInstant   = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

// parseInstantString reads an ISO 8601 date-time. With an offset or Z it is that instant. With no offset it is
// UTC, whatever the host zone is. A date alone is 00:00 UTC (SPEC 9.1.1).
func parseInstantString(s string) (time.Time, bool) {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t, true
	}
	if offsetlessInstant.MatchString(s) {
		for _, layout := range []string{"2006-01-02T15:04:05", "2006-01-02T15:04"} {
			if t, err := time.ParseInLocation(layout, s, time.UTC); err == nil {
				return t, true
			}
		}
		return time.Time{}, false
	}
	if dateOnlyInstant.MatchString(s) {
		if t, err := time.ParseInLocation("2006-01-02", s, time.UTC); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// instantOf reads an instant field (SPEC 9.1.1). present is false when the field is absent: nil, a nil pointer,
// or a zero time.Time. valid is false when the field is present but is not an instant. A number is epoch
// milliseconds. A *string or *time.Time is read as the value it points to.
func instantOf(v any) (t time.Time, present, valid bool) {
	switch x := v.(type) {
	case nil:
		return time.Time{}, false, false
	case time.Time:
		if x.IsZero() {
			return time.Time{}, false, false
		}
		return x, true, true
	case *time.Time:
		if x == nil {
			return time.Time{}, false, false
		}
		return instantOf(*x)
	case string:
		t, ok := parseInstantString(x)
		return t, true, ok
	case *string:
		if x == nil {
			return time.Time{}, false, false
		}
		return instantOf(*x)
	}
	if n, ok := numberOf(v); ok {
		if math.IsNaN(n) || math.IsInf(n, 0) {
			return time.Time{}, true, false
		}
		return time.UnixMilli(int64(n)), true, true
	}
	return time.Time{}, true, false
}
