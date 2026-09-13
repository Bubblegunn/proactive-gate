package proactivegate

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

const daySeconds = 24 * 60 * 60

var weekdays = [...]string{"sun", "mon", "tue", "wed", "thu", "fri", "sat"}

// localClock resolves an instant to local minutes and the local calendar day
// in an IANA zone (6.1). The day string is always zero-padded to four digits:
// the local day of an instant in year 1 is "0001-06-01".
func localClock(now time.Time, timezone string) (minutes int, day string, err error) {
	loc, err := time.LoadLocation(timezone)
	if err != nil {
		return 0, "", fmt.Errorf("unknown time zone %q", timezone)
	}
	local := now.In(loc)
	return local.Hour()*60 + local.Minute(), fmt.Sprintf("%04d-%02d-%02d", local.Year(), int(local.Month()), local.Day()), nil
}

// localDay is the calendar day of an instant in the user's zone, or UTC when
// no zone is set (6.1).
func localDay(now time.Time, timezone string) (string, error) {
	if timezone == "" {
		u := now.UTC()
		return fmt.Sprintf("%04d-%02d-%02d", u.Year(), int(u.Month()), u.Day()), nil
	}
	_, day, err := localClock(now, timezone)
	return day, err
}

// parseHHMM reads "HH:MM" into minutes since local midnight.
func parseHHMM(text string) (int, error) {
	h, m, ok := strings.Cut(text, ":")
	if !ok {
		return 0, fmt.Errorf("bad time %q, expected HH:MM", text)
	}
	hh, errH := strconv.Atoi(h)
	mm, errM := strconv.Atoi(m)
	if errH != nil || errM != nil {
		return 0, fmt.Errorf("bad time %q, expected HH:MM", text)
	}
	return hh*60 + mm, nil
}

// inWindow reports whether minutes falls inside [start, end), where the
// window may cross midnight. start == end is an empty window (6.3).
func inWindow(minutes, start, end int) bool {
	if start == end {
		return false
	}
	if start < end {
		return minutes >= start && minutes < end
	}
	return minutes >= start || minutes < end
}

// parseDay splits a "YYYY-MM-DD" local calendar date into fields. These are
// calendar dates, not instants, so nothing here may read a wall clock.
func parseDay(day string) (y, m, d int, err error) {
	var a, b string
	var ok bool
	a, rest, ok := strings.Cut(day, "-")
	if !ok {
		return 0, 0, 0, fmt.Errorf("bad local day %q", day)
	}
	b, c, ok := strings.Cut(rest, "-")
	if !ok {
		return 0, 0, 0, fmt.Errorf("bad local day %q", day)
	}
	if y, err = strconv.Atoi(a); err != nil {
		return 0, 0, 0, fmt.Errorf("bad local day %q", day)
	}
	if m, err = strconv.Atoi(b); err != nil {
		return 0, 0, 0, fmt.Errorf("bad local day %q", day)
	}
	if d, err = strconv.Atoi(c); err != nil {
		return 0, 0, 0, fmt.Errorf("bad local day %q", day)
	}
	return y, m, d, nil
}

// weekdayOf is the weekday of a local calendar date, derived from the date
// itself and never from an instant (6.6). A date the zone skipped entirely,
// like Apia's 2011-12-30, still has a weekday in the proleptic Gregorian
// calendar the schedule is written against.
func weekdayOf(day string) (string, error) {
	y, m, d, err := parseDay(day)
	if err != nil {
		return "", err
	}
	return weekdays[int(time.Date(y, time.Month(m), d, 0, 0, 0, 0, time.UTC).Weekday())], nil
}

// dayBefore is the calendar date before a local date, as pure calendar
// arithmetic. When a zone skips a day the arithmetic still names it, which is
// how a window "opened" on a day that never happened keeps its tail.
func dayBefore(day string) (string, error) {
	y, m, d, err := parseDay(day)
	if err != nil {
		return "", err
	}
	prev := time.Date(y, time.Month(m), d-1, 0, 0, 0, 0, time.UTC)
	return fmt.Sprintf("%04d-%02d-%02d", prev.Year(), int(prev.Month()), prev.Day()), nil
}

// windowFor resolves the quiet window in force on one local date: a caller
// supplied date beats a weekday beats the default (6.4). A present key whose
// value is null means the day has no quiet hours.
func windowFor(q *QuietHours, day string) (*QuietWindow, error) {
	if q.window != nil {
		return q.window, nil
	}
	if q.dates != nil {
		if e, ok := q.dates[day]; ok {
			return e.window, nil
		}
	}
	if q.days != nil {
		wd, err := weekdayOf(day)
		if err != nil {
			return nil, err
		}
		if e, ok := q.days[wd]; ok {
			return e.window, nil
		}
	}
	if q.def.set {
		return q.def.window, nil
	}
	return nil, nil
}

// quietHit is a window and the local date it was resolved for.
type quietHit struct {
	window *QuietWindow
	day    string
}

// quietAt reports whether a local time is inside quiet hours, and which day's
// window says so. A window belongs to the day it opens on (6.5), so a time is
// quiet when today's window contains it or yesterday's window crosses midnight
// and has not ended yet. Today's window takes precedence when both apply.
func quietAt(q *QuietHours, day string, minutes int) (*quietHit, error) {
	if today, err := windowFor(q, day); err != nil {
		return nil, err
	} else if today != nil {
		start, err := parseHHMM(today.Start)
		if err != nil {
			return nil, err
		}
		end, err := parseHHMM(today.End)
		if err != nil {
			return nil, err
		}
		if start != end && (start < end && minutes >= start && minutes < end || start > end && minutes >= start) {
			return &quietHit{window: today, day: day}, nil
		}
	}
	yesterday, err := dayBefore(day)
	if err != nil {
		return nil, err
	}
	if prev, err := windowFor(q, yesterday); err != nil {
		return nil, err
	} else if prev != nil {
		start, err := parseHHMM(prev.Start)
		if err != nil {
			return nil, err
		}
		end, err := parseHHMM(prev.End)
		if err != nil {
			return nil, err
		}
		if start > end && minutes < end {
			return &quietHit{window: prev, day: yesterday}, nil
		}
	}
	return nil, nil
}

// isoWeekKey is the "YYYY-Www" ISO week of a local calendar date (5.1). The
// ISO week-year is not the calendar year: late December can belong to next
// year's week 1 and early January to a week 53 just ended.
func isoWeekKey(day string) (string, error) {
	y, m, d, err := parseDay(day)
	if err != nil {
		return "", err
	}
	isoYear, week := time.Date(y, time.Month(m), d, 0, 0, 0, 0, time.UTC).ISOWeek()
	return fmt.Sprintf("%04d-W%02d", isoYear, week), nil
}

// isoMillis renders an instant the way the fixtures expect it: UTC, always
// with three millisecond digits, ending in Z.
func isoMillis(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// parseInstant reads an ISO instant from a caller supplied field. An
// unparseable value, such as a 23:59:60 leap second no runtime accepts, reads
// as absent rather than as an error.
func parseInstant(s *string) *time.Time {
	if s == nil {
		return nil
	}
	if t, err := time.Parse(time.RFC3339Nano, *s); err == nil {
		return &t
	}
	return nil
}
