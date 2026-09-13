package proactivegate

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"time"
)

/* ------------------------------------------------------------------------ */
/* The checks, in the order the default battery runs them.                   */
/* ------------------------------------------------------------------------ */

// killSwitch is a production hard-stop that silences every producer at once.
// The JSON policy form takes a static "on" flag.
func killSwitch(on bool) Check {
	return Check{
		ID: "killSwitch",
		Run: func(ctx *CheckContext) (Outcome, error) {
			if on {
				return reject("engine kill switch is on"), nil
			}
			return pass(), nil
		},
	}
}

// consent comes before everything, or the gate has evaluated preferences for
// someone who never agreed.
func consent() Check {
	return Check{
		ID: "consent",
		Run: func(ctx *CheckContext) (Outcome, error) {
			if ctx.User.Consent {
				return pass(), nil
			}
			return reject("user has not consented to proactive behaviour"), nil
		},
	}
}

// enabled is proactive behaviour switched on for this profile. It defaults to
// on when the field is undefined.
func enabled() Check {
	return Check{
		ID: "enabled",
		Run: func(ctx *CheckContext) (Outcome, error) {
			if ctx.User.ProactiveEnabled != nil && !*ctx.User.ProactiveEnabled {
				return reject("proactive behaviour is disabled on this profile"), nil
			}
			return pass(), nil
		},
	}
}

// mode allows proactive messages only in the listed operating modes. An
// undefined mode passes.
func mode(allow []string) Check {
	return Check{
		ID: "mode",
		Run: func(ctx *CheckContext) (Outcome, error) {
			if ctx.User.Mode != "" && !contains(allow, ctx.User.Mode) {
				return reject(fmt.Sprintf("operating mode %q does not allow proactive messages", ctx.User.Mode)), nil
			}
			return pass(), nil
		},
	}
}

// snooze is a global pause until an instant. With defer set the decision
// carries the instant as retryAt instead of rejecting.
func snooze(deferOption bool) Check {
	return Check{
		ID: "snooze",
		Run: func(ctx *CheckContext) (Outcome, error) {
			until := parseInstant(ctx.User.SnoozedUntil)
			if until == nil || !until.After(ctx.Now) {
				return pass(), nil
			}
			reason := "snoozed until " + isoMillis(*until)
			if deferOption {
				return deferTo(reason, *until), nil
			}
			return reject(reason), nil
		},
	}
}

// mute is the per-type mute.
func mute() Check {
	return Check{
		ID: "mute",
		Run: func(ctx *CheckContext) (Outcome, error) {
			if contains(ctx.User.MutedTypes, ctx.Candidate.Type) {
				return reject(fmt.Sprintf("type %q is muted by the user", ctx.Candidate.Type)), nil
			}
			return pass(), nil
		},
	}
}

// intensity maps the user's intensity setting to a priority floor: low hears
// only high priority, normal hears normal and up, high hears everything.
func intensity(floors map[string]Priority) Check {
	if floors == nil {
		floors = map[string]Priority{"low": PriorityHigh, "normal": PriorityNormal, "high": PriorityLow}
	}
	return Check{
		ID: "intensity",
		Run: func(ctx *CheckContext) (Outcome, error) {
			name := ctx.User.Intensity
			if name == "" {
				name = "normal"
			}
			floor, ok := floors[name]
			if !ok {
				floor = floors["normal"]
			}
			if atLeast(ctx.Priority, floor) {
				return pass(), nil
			}
			return reject(fmt.Sprintf("priority %s is below the %q intensity floor (%s)", ctx.Priority, name, floor)), nil
		},
	}
}

// quietHours is the timezone-aware quiet window, bypassed only at or above
// the priority floor. Without a timezone on the user the check cannot place
// the window in the day and skips.
func quietHours(priorityFloor Priority) Check {
	if priorityFloor == "" {
		priorityFloor = PriorityCritical
	}
	return Check{
		ID: "quietHours",
		Run: func(ctx *CheckContext) (Outcome, error) {
			if ctx.User.QuietHours == nil {
				return pass(), nil
			}
			if ctx.User.Timezone == "" {
				return skip("quiet hours set but no timezone on the user; cannot evaluate"), nil
			}
			minutes, day, err := localClock(ctx.Now, ctx.User.Timezone)
			if err != nil {
				return Outcome{}, err
			}
			hit, err := quietAt(ctx.User.QuietHours, day, minutes)
			if err != nil {
				return Outcome{}, err
			}
			if hit == nil || atLeast(ctx.Priority, priorityFloor) {
				return pass(), nil
			}
			// Name the day the window came from: when it crossed midnight the
			// reason is yesterday's setting, and a reader looking at today's
			// would not find it.
			whose := ""
			if hit.day != day {
				wd, err := weekdayOf(hit.day)
				if err != nil {
					return Outcome{}, err
				}
				whose = fmt.Sprintf(" (%s %s)", wd, hit.day)
			}
			return reject(fmt.Sprintf("quiet hours %s to %s%s %s; priority %s is below the floor (%s)",
				hit.window.Start, hit.window.End, whose, ctx.User.Timezone, ctx.Priority, priorityFloor)), nil
		},
	}
}

// trustRamp: for the first days after sign-up the user hears from the system
// only at or above minPriority.
func trustRamp(days float64, minPriority Priority) Check {
	if days == 0 {
		days = 7
	}
	if minPriority == "" {
		minPriority = PriorityHigh
	}
	return Check{
		ID: "trustRamp",
		Run: func(ctx *CheckContext) (Outcome, error) {
			created := parseInstant(ctx.User.CreatedAt)
			if created == nil {
				return skip("no createdAt on the user; ramp cannot be evaluated"), nil
			}
			age := float64(ctx.Now.Sub(*created)) / float64(daySeconds*time.Second)
			if age >= days {
				return pass(), nil
			}
			if atLeast(ctx.Priority, minPriority) {
				return pass(), nil
			}
			return reject(fmt.Sprintf("trust ramp: day %d of %s, priority %s is below %s",
				int(math.Floor(age))+1, formatNumber(days), ctx.Priority, minPriority)), nil
		},
	}
}

func dismissalKey(userID, typ string) string { return "cooldown:" + userID + ":" + typ }

// dismissalCooldown: when the user has dismissed n candidates of a type
// within withinDays, that type stays silent for silenceDays from the most
// recent dismissal.
func dismissalCooldown(dismissals int64, withinDays, silenceDays float64) Check {
	if dismissals == 0 {
		dismissals = 3
	}
	if withinDays == 0 {
		withinDays = 30
	}
	if silenceDays == 0 {
		silenceDays = 7
	}
	return Check{
		ID: "dismissalCooldown",
		Run: func(ctx *CheckContext) (Outcome, error) {
			raw, ok, err := ctx.Store.Get(dismissalKey(ctx.User.ID, ctx.Candidate.Type))
			if err != nil {
				return Outcome{}, err
			}
			var stamps []int64
			if ok {
				if err := json.Unmarshal([]byte(raw), &stamps); err != nil {
					return Outcome{}, err
				}
			}
			windowStart := ctx.Now.UnixMilli() - int64(withinDays*daySeconds*1000)
			var recent []int64
			for _, t := range stamps {
				if t >= windowStart {
					recent = append(recent, t)
				}
			}
			sort.Slice(recent, func(i, j int) bool { return recent[i] < recent[j] })
			if int64(len(recent)) < dismissals {
				return pass(), nil
			}
			latest := recent[len(recent)-1]
			silentUntil := latest + int64(silenceDays*daySeconds*1000)
			if ctx.Now.UnixMilli() >= silentUntil {
				return pass(), nil
			}
			return reject(fmt.Sprintf("%d dismissals of %q in %s days; silent until %s",
				len(recent), ctx.Candidate.Type, formatNumber(withinDays),
				isoMillis(time.UnixMilli(silentUntil)))), nil
		},
	}
}

// adaptiveTiming never rejects. In a JSON policy it can carry no function, so
// the placeholder passes and keeps the trace shape.
func adaptiveTiming() Check {
	return Check{
		ID:           "adaptiveTiming",
		NonRejecting: true,
		Run: func(ctx *CheckContext) (Outcome, error) {
			return pass(), nil
		},
	}
}

/* ------------------------------------------------------------------------ */
/* Budgets. The check reads the counter; Commit calls Consume, which         */
/* increments atomically and can still refuse when two instances race.       */
/* ------------------------------------------------------------------------ */

// budgetOptions are the knobs every budget-like check takes.
type budgetOptions struct {
	Limit          int64
	BypassPriority Priority
	// NearLimit is the fraction of the limit at which a pass carries a
	// nearLimit note. Default 0.8.
	NearLimit float64
}

// budget builds one counter check: a read at evaluate, an atomic increment at
// commit.
func budget(id, label string, defaultLimit int64, keyFor func(ctx *CheckContext) (string, error), ttlSeconds int64, o budgetOptions) Check {
	limit := o.Limit
	if limit == 0 {
		limit = defaultLimit
	}
	nearFraction := o.NearLimit
	if nearFraction == 0 {
		nearFraction = 0.8
	}
	nearAt := int64(math.Max(1, math.Ceil(float64(limit)*nearFraction)))
	bypass := func(p Priority) bool { return o.BypassPriority != "" && atLeast(p, o.BypassPriority) }
	return Check{
		ID: id,
		Run: func(ctx *CheckContext) (Outcome, error) {
			if bypass(ctx.Priority) {
				return pass(), nil
			}
			key, err := keyFor(ctx)
			if err != nil {
				return Outcome{}, err
			}
			raw, ok, err := ctx.Store.Get(key)
			if err != nil {
				return Outcome{}, err
			}
			var used int64
			if ok {
				used, err = strconv.ParseInt(raw, 10, 64)
				if err != nil {
					return Outcome{}, err
				}
			}
			if used >= limit {
				return reject(fmt.Sprintf("%s of %d used (%d)", label, limit, used)), nil
			}
			if used >= nearAt {
				return Outcome{Kind: OutcomePass, Reason: fmt.Sprintf("%d of %d used", used, limit), NearLimit: &NearLimit{Used: used, Limit: limit}}, nil
			}
			return pass(), nil
		},
		Consume: func(ctx *CheckContext) (bool, error) {
			if bypass(ctx.Priority) {
				return true, nil
			}
			key, err := keyFor(ctx)
			if err != nil {
				return false, err
			}
			used, err := ctx.Store.Incr(key, ttlSeconds)
			if err != nil {
				return false, err
			}
			return used <= limit, nil
		},
	}
}

func budgetKey(userID string, now time.Time, timezone string) (string, error) {
	day, err := localDay(now, timezone)
	if err != nil {
		return "", err
	}
	return "budget:" + userID + ":" + day, nil
}

func weeklyBudgetKey(userID string, now time.Time, timezone string) (string, error) {
	day, err := localDay(now, timezone)
	if err != nil {
		return "", err
	}
	week, err := isoWeekKey(day)
	if err != nil {
		return "", err
	}
	return "weeklyBudget:" + userID + ":" + week, nil
}

func monthlyBudgetKey(userID string, now time.Time, timezone string) (string, error) {
	day, err := localDay(now, timezone)
	if err != nil {
		return "", err
	}
	return "monthlyBudget:" + userID + ":" + day[:7], nil
}

// dailyBudget allows at most limit deliveries per user per local day.
func dailyBudget(o budgetOptions) Check {
	return budget("dailyBudget", "daily budget", 5,
		func(ctx *CheckContext) (string, error) { return budgetKey(ctx.User.ID, ctx.Now, ctx.User.Timezone) },
		2*daySeconds, o)
}

// weeklyBudget allows at most limit deliveries per user per local ISO week.
// The counter resets on Monday morning in the user's zone.
func weeklyBudget(o budgetOptions) Check {
	return budget("weeklyBudget", "weekly budget", 20,
		func(ctx *CheckContext) (string, error) {
			return weeklyBudgetKey(ctx.User.ID, ctx.Now, ctx.User.Timezone)
		},
		8*daySeconds, o)
}

// monthlyBudget allows at most limit deliveries per user per local calendar
// month.
func monthlyBudget(o budgetOptions) Check {
	return budget("monthlyBudget", "monthly budget", 60,
		func(ctx *CheckContext) (string, error) {
			return monthlyBudgetKey(ctx.User.ID, ctx.Now, ctx.User.Timezone)
		},
		32*daySeconds, o)
}

func dedupeKeyFor(userID, key string) string { return "dedupe:" + userID + ":" + key }

func humanWindow(seconds int64) string {
	switch {
	case seconds%daySeconds == 0:
		return fmt.Sprintf("%dd", seconds/daySeconds)
	case seconds%3600 == 0:
		return fmt.Sprintf("%dh", seconds/3600)
	case seconds%60 == 0:
		return fmt.Sprintf("%dm", seconds/60)
	default:
		return fmt.Sprintf("%ds", seconds)
	}
}

// dedupe allows one delivery per event per window, claimed atomically at
// commit time (5.6). With no dedupeKey on the candidate it skips rather than
// guessing an identity (5.5). The window is fixed from the first claim (5.8).
func dedupe(windowSeconds int64) Check {
	if windowSeconds == 0 {
		windowSeconds = daySeconds
	}
	label := humanWindow(windowSeconds)
	return Check{
		ID: "dedupe",
		Run: func(ctx *CheckContext) (Outcome, error) {
			if ctx.Candidate.DedupeKey == "" {
				return skip("no dedupeKey on the candidate; deduplication cannot be evaluated"), nil
			}
			_, seen, err := ctx.Store.Get(dedupeKeyFor(ctx.User.ID, ctx.Candidate.DedupeKey))
			if err != nil {
				return Outcome{}, err
			}
			if seen {
				return reject("already delivered within the last " + label), nil
			}
			return pass(), nil
		},
		Consume: func(ctx *CheckContext) (bool, error) {
			if ctx.Candidate.DedupeKey == "" {
				return true, nil
			}
			claims, err := ctx.Store.Incr(dedupeKeyFor(ctx.User.ID, ctx.Candidate.DedupeKey), windowSeconds)
			if err != nil {
				return false, err
			}
			return claims == 1, nil
		},
	}
}

/* ------------------------------------------------------------------------ */
/* Optional, caller-fed checks.                                              */
/* ------------------------------------------------------------------------ */

// utilityFloor is expected-utility alerting: act only when the caller's
// estimate of acceptance clears tau = cFA / (cFA + pNeed * cFN), the Bayes
// decision boundary between a false alarm and missed help.
func utilityFloor(costFalseAlarm, costMissedHelp float64) Check {
	return Check{
		ID: "utilityFloor",
		Run: func(ctx *CheckContext) (Outcome, error) {
			if ctx.Candidate.PAccept == nil {
				return skip("no pAccept on the candidate; utility floor cannot be evaluated"), nil
			}
			pNeed := 1.0
			if ctx.Candidate.PNeed != nil {
				pNeed = *ctx.Candidate.PNeed
			}
			tau := costFalseAlarm / (costFalseAlarm + pNeed*costMissedHelp)
			if *ctx.Candidate.PAccept >= tau {
				return pass(), nil
			}
			return reject(fmt.Sprintf("pAccept %s < tau %s", round3(*ctx.Candidate.PAccept), round3(tau))), nil
		},
	}
}

func round3(n float64) string {
	return strconv.FormatFloat(math.Round(n*1000)/1000, 'f', -1, 64)
}

// boundedDeferral waits, when the user is busy, t* = min(bound,
// lambda * interruptCost / (2 * staleness)): the optimum of a quadratic
// staleness loss against the cost of interrupting a busy person. Never
// rejects; only moves deliverAt.
func boundedDeferral(lambda, interruptCost, staleness, boundSeconds float64) Check {
	if lambda == 0 {
		lambda = 1.0 / 43.0
	}
	if interruptCost == 0 {
		interruptCost = 1
	}
	if staleness == 0 {
		staleness = 0.0001
	}
	if boundSeconds == 0 {
		boundSeconds = 240
	}
	tStar := math.Min(boundSeconds, lambda*interruptCost/(2*staleness))
	return Check{
		ID:           "boundedDeferral",
		NonRejecting: true,
		Run: func(ctx *CheckContext) (Outcome, error) {
			if !ctx.Candidate.Busy {
				return pass(), nil
			}
			at := ctx.Now.Add(time.Duration(int64(math.Round(tStar*1000))) * time.Millisecond)
			return Outcome{
				Kind:      OutcomeAdjust,
				Reason:    fmt.Sprintf("user busy; deliver at %s (t* %d s)", isoMillis(at), int64(math.Round(tStar))),
				DeliverAt: &at,
			}, nil
		},
	}
}

/* ------------------------------------------------------------------------ */
/* Primitives the presets compose.                                           */
/* ------------------------------------------------------------------------ */

func zoneOf(ctx *CheckContext, timezone string) string {
	if timezone == "user" {
		return ctx.User.Timezone
	}
	return timezone
}

// allowedWindow allows deliveries only inside [start, end) local time in a
// fixed zone or the user's.
func allowedWindow(start, end, timezone string, priorityFloor Priority, id string) (Check, error) {
	startMin, err := parseHHMM(start)
	if err != nil {
		return Check{}, err
	}
	endMin, err := parseHHMM(end)
	if err != nil {
		return Check{}, err
	}
	if id == "" {
		id = "allowedWindow"
	}
	return Check{
		ID: id,
		Run: func(ctx *CheckContext) (Outcome, error) {
			zone := zoneOf(ctx, timezone)
			if zone == "" {
				return skip("no timezone on the user; window cannot be evaluated"), nil
			}
			if priorityFloor != "" && atLeast(ctx.Priority, priorityFloor) {
				return pass(), nil
			}
			minutes, _, err := localClock(ctx.Now, zone)
			if err != nil {
				return Outcome{}, err
			}
			if inWindow(minutes, startMin, endMin) {
				return pass(), nil
			}
			return reject(fmt.Sprintf("outside the allowed window %s to %s %s", start, end, zone)), nil
		},
	}, nil
}

// requiresConsent requires user.consents[name], always or only inside a
// local-time window.
func requiresConsent(name string, when *QuietWindow, whenZone string, id string) (Check, error) {
	var startMin, endMin int
	if when != nil {
		var err error
		startMin, err = parseHHMM(when.Start)
		if err != nil {
			return Check{}, err
		}
		endMin, err = parseHHMM(when.End)
		if err != nil {
			return Check{}, err
		}
	}
	if id == "" {
		id = "consent:" + name
	}
	return Check{
		ID: id,
		Run: func(ctx *CheckContext) (Outcome, error) {
			if when != nil {
				zone := zoneOf(ctx, whenZone)
				if zone == "" {
					return skip("no timezone on the user; consent window cannot be evaluated"), nil
				}
				minutes, _, err := localClock(ctx.Now, zone)
				if err != nil {
					return Outcome{}, err
				}
				// A bare pass here would be indistinguishable from "the consent
				// is on file", so outside the window the pass says why.
				if !inWindow(minutes, startMin, endMin) {
					return passReason(fmt.Sprintf("outside the consent window %s to %s", when.Start, when.End)), nil
				}
			}
			if ctx.User.Consents[name] {
				return pass(), nil
			}
			reason := fmt.Sprintf("consent %q is missing", name)
			if when != nil {
				reason += fmt.Sprintf(" (required %s to %s)", when.Start, when.End)
			}
			return reject(reason), nil
		},
	}, nil
}

// rateLimit is a fixed-window rate limit keyed by user or by
// candidate.channel, consumed at commit.
func rateLimit(limit, perSeconds int64, keyBy, id string) Check {
	if keyBy == "" {
		keyBy = "user"
	}
	keyFor := func(ctx *CheckContext) (string, error) {
		scope := ctx.User.ID
		if keyBy == "channel" && ctx.Candidate.Channel != "" {
			scope = ctx.Candidate.Channel
		}
		bucket := ctx.Now.Unix() / perSeconds
		return fmt.Sprintf("rate:%s:%s:%d:%d", keyBy, scope, perSeconds, bucket), nil
	}
	if id == "" {
		id = fmt.Sprintf("rate:%d/%ds", limit, perSeconds)
	}
	return budget(id, fmt.Sprintf("rate limit %d per %d s", limit, perSeconds), limit, keyFor, perSeconds*2,
		budgetOptions{Limit: limit, NearLimit: 1})
}

// recentInteraction requires that the user wrote to the assistant within the
// last withinHours.
func recentInteraction(withinHours float64) Check {
	return Check{
		ID: "recentInteraction",
		Run: func(ctx *CheckContext) (Outcome, error) {
			last := parseInstant(ctx.User.LastInboundAt)
			if last == nil {
				return reject("no inbound message from the user on record"), nil
			}
			age := float64(ctx.Now.Sub(*last)) / float64(time.Hour)
			if age <= withinHours {
				return pass(), nil
			}
			return reject(fmt.Sprintf("last inbound message %d h ago, window is %s h",
				int64(math.Floor(age)), formatNumber(withinHours))), nil
		},
	}
}

// windowBudget allows at most limit deliveries in the withinHours window that
// opened with the user's last inbound message.
func windowBudget(limit int64, withinHours float64) Check {
	keyFor := func(ctx *CheckContext) (string, error) {
		last := parseInstant(ctx.User.LastInboundAt)
		opened := "none"
		if last != nil {
			opened = strconv.FormatInt(last.Unix(), 10)
		}
		return "windowBudget:" + ctx.User.ID + ":" + opened, nil
	}
	return budget("windowBudget", "window budget", limit, keyFor, int64(withinHours*3600),
		budgetOptions{Limit: limit, NearLimit: 1})
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// formatNumber renders a whole float without a trailing ".0" so reasons read
// "3 dismissals in 30 days" rather than "30.0 days".
func formatNumber(n float64) string {
	return strconv.FormatFloat(n, 'f', -1, 64)
}
