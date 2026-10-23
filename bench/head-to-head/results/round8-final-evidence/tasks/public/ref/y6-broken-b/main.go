// Broken B for Y6, Go. Mistake 1: the cap counts sent calls per UTC calendar day (the day key uses the instant in UTC),
// not per local day. Mistake 2: a critical case is held by quiet hours (the critical exemption is missing).
// Expected FAILS: 3, 4, 5. Criteria 1 and 2 pass (the Node and Python programs are the reference), and 6 passes because
// the Go program still reads policy.json and exits non-zero on a missing or invalid file.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"
)

type QuietHours struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

type Policy struct {
	QuietHours     *QuietHours `json:"quietHours"`
	DailyCap       *int        `json:"dailyCap"`
	RequireConsent bool        `json:"requireConsent"`
}

type Case struct {
	UserID   string `json:"userId"`
	Timezone string `json:"timezone"`
	Consent  bool   `json:"consent"`
	At       string `json:"at"`
	Priority string `json:"priority"`
}

type Result struct {
	Index   int    `json:"index"`
	Outcome string `json:"outcome"`
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}

func toMinutes(hhmm string) int {
	parts := strings.Split(hhmm, ":")
	if len(parts) != 2 {
		fail("policy.json has a bad time %q", hhmm)
	}
	h, err1 := strconv.Atoi(parts[0])
	m, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil {
		fail("policy.json has a bad time %q", hhmm)
	}
	return h*60 + m
}

func main() {
	raw, err := os.ReadFile("policy.json")
	if err != nil {
		fail("policy.json is missing from the current folder: %v", err)
	}
	var p Policy
	if err := json.Unmarshal(raw, &p); err != nil {
		fail("policy.json is not valid JSON: %v", err)
	}
	if len(os.Args) < 2 {
		fail("usage: go run . cases.json")
	}
	rawCases, err := os.ReadFile(os.Args[1])
	if err != nil {
		fail("cannot read case file: %v", err)
	}
	var cases []Case
	if err := json.Unmarshal(rawCases, &cases); err != nil {
		fail("cannot parse case file: %v", err)
	}

	var quietStart, quietEnd int
	if p.QuietHours != nil {
		quietStart = toMinutes(p.QuietHours.Start)
		quietEnd = toMinutes(p.QuietHours.End)
	}
	inQuiet := func(minute int) bool {
		if quietStart < quietEnd {
			return minute >= quietStart && minute < quietEnd
		}
		return minute >= quietStart || minute < quietEnd
	}

	counts := map[string]int{}
	out := make([]Result, 0, len(cases))
	for i, c := range cases {
		at, err := time.Parse(time.RFC3339, c.At)
		if err != nil {
			fail("bad instant %q: %v", c.At, err)
		}
		loc, err := time.LoadLocation(c.Timezone)
		if err != nil {
			fail("bad timezone %q: %v", c.Timezone, err)
		}
		local := at.In(loc)
		day := at.UTC().Format("2006-01-02")
		minute := local.Hour()*60 + local.Minute()
		key := c.UserID + "|" + day

		var outcome string
		switch {
		case p.RequireConsent && !c.Consent:
			outcome = "consent"
		case p.QuietHours != nil && inQuiet(minute):
			outcome = "quiet"
		case p.DailyCap != nil && counts[key] >= *p.DailyCap:
			outcome = "cap"
		default:
			outcome = "sent"
			counts[key]++
		}
		out = append(out, Result{Index: i, Outcome: outcome})
	}
	b, err := json.Marshal(out)
	if err != nil {
		fail("cannot encode output: %v", err)
	}
	os.Stdout.Write(append(b, '\n'))
}
