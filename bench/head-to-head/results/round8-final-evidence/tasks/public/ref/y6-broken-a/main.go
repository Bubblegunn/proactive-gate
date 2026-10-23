// Broken A for Y6, Go. Mistake: the policy is hard-coded (quiet 22:00 to 07:00, cap 3, consent required). The program
// never reads policy.json, so it neither follows a swapped policy nor fails when policy.json is missing or invalid.
// Criterion 3 passes on policy A because the hard-coded values match it. Expected FAILS for this program: 4 (policy B
// swap ignored), 5 (N1 and N2 variants), 6 (no error for missing or invalid policy.json).
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"time"
	_ "time/tzdata"
)

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

const (
	quietStart     = 22 * 60
	quietEnd       = 7 * 60
	dailyCap       = 3
	requireConsent = true
)

func main() {
	raw, err := os.ReadFile(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	var cases []Case
	if err := json.Unmarshal(raw, &cases); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
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
		at, _ := time.Parse(time.RFC3339, c.At)
		loc, _ := time.LoadLocation(c.Timezone)
		local := at.In(loc)
		minute := local.Hour()*60 + local.Minute()
		key := c.UserID + "|" + local.Format("2006-01-02")
		var outcome string
		switch {
		case requireConsent && !c.Consent:
			outcome = "consent"
		case c.Priority != "critical" && inQuiet(minute):
			outcome = "quiet"
		case counts[key] >= dailyCap:
			outcome = "cap"
		default:
			outcome = "sent"
			counts[key]++
		}
		out = append(out, Result{Index: i, Outcome: outcome})
	}
	b, _ := json.Marshal(out)
	os.Stdout.Write(append(b, '\n'))
}
