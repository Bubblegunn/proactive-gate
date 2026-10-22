package proactivegate

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Hour counters are kept for 90 days after their last increment (SPEC 9.11).
const hourTTLSeconds = 90 * daySeconds

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

// killSwitchFlag rejects while the runtime flag name is exactly false. An
// absent flag, or any value other than false, stops nothing (SPEC 9.13).
func killSwitchFlag(name string) Check {
	return Check{
		ID: "killSwitch",
		Run: func(ctx *CheckContext) (Outcome, error) {
			if v, ok := ctx.Flags[name]; ok && !v {
				return reject(fmt.Sprintf("kill switch is on: flag %q is false", name)), nil
			}
			return pass(), nil
		},
	}
}

// consent comes before everything, or the gate has evaluated preferences for
// someone who never agreed. When the consent lookup failed (consentUnknown),
// failMode decides, surface by surface, what stays open (SPEC 9.3). A nil
// failMode closes every surface.
func consent(failMode map[string]string) Check {
	return Check{
		ID: "consent",
		Run: func(ctx *CheckContext) (Outcome, error) {
			if ctx.User.ConsentUnknown {
				var kept []string
				for _, s := range ctx.Surfaces {
					if failModeFor(failMode, s) == "open" {
						kept = append(kept, s)
					}
				}
				if len(kept) == 0 {
					return reject("consent could not be determined and no surface on the table fails open"), nil
				}
				return Outcome{Kind: OutcomeAdjust, Reason: fmt.Sprintf("consent could not be determined; keeping %s", strings.Join(kept, ", ")), Surfaces: kept}, nil
			}
			if ctx.User.Consent {
				return pass(), nil
			}
			return reject("user has not consented to proactive behaviour"), nil
		},
	}
}

// failModeFor is the mode of one surface: its own entry, else "default", else
// "closed" (SPEC 9.3).
func failModeFor(failMode map[string]string, surface string) string {
	if mode, ok := failMode[surface]; ok {
		return mode
	}
	if mode, ok := failMode["default"]; ok {
		return mode
	}
	return "closed"
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
		NextAllowedAt: func(ctx *CheckContext) (*time.Time, error) {
			return parseInstant(ctx.User.SnoozedUntil), nil
		},
	}
}

// mute is the per-type mute. A commitment is not muted (SPEC 9.4).
func mute() Check {
	return Check{
		ID: "mute",
		Run: func(ctx *CheckContext) (Outcome, error) {
			if isCommitment(ctx.Candidate) {
				return pass(), nil
			}
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
// the priority floor. The window is placed in the user's effective zone (SPEC
// 9.2). Without a zone the check skips, or with onMissingTimezone "reject"
// rejects before it looks at the window (SPEC 9.2.1).
func quietHours(priorityFloor Priority, onMissingTimezone string) Check {
	if priorityFloor == "" {
		priorityFloor = PriorityCritical
	}
	rejectWithoutZone := onMissingTimezone == "reject"
	zoneOf := func(u *UserState) string {
		if rejectWithoutZone {
			return reportedZone(u)
		}
		return effectiveZone(u)
	}
	return Check{
		ID: "quietHours",
		Run: func(ctx *CheckContext) (Outcome, error) {
			zone := zoneOf(ctx.User)
			if zone == "" && rejectWithoutZone {
				return reject("no time zone on the user; quiet hours cannot be evaluated"), nil
			}
			if ctx.User.QuietHours == nil {
				return pass(), nil
			}
			if zone == "" {
				return skip("quiet hours set but no timezone on the user; cannot evaluate"), nil
			}
			minutes, day, err := localClock(ctx.Now, zone)
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
				hit.window.Start, hit.window.End, whose, zone, ctx.Priority, priorityFloor)), nil
		},
		NextAllowedAt: func(ctx *CheckContext) (*time.Time, error) {
			zone := zoneOf(ctx.User)
			if ctx.User.QuietHours == nil || zone == "" {
				return nil, nil
			}
			return quietEndsAt(ctx.User.QuietHours, zone, ctx.Now)
		},
	}
}

// trustRamp: for the first days after sign-up the user hears from the system
// only at or above minPriority. A candidate the person requested, or a
// commitment they set up, is their own doing and passes (SPEC 9.4, 9.5).
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
			if ctx.Candidate.Requested {
				return passReason("requested by the person; the trust ramp does not apply"), nil
			}
			if isCommitment(ctx.Candidate) {
				return passReason("a commitment the person set up; the trust ramp does not apply"), nil
			}
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
// recent dismissal. Commitments and the listed exemptTypes are never silenced
// (SPEC 9.4, 9.6).
func dismissalCooldown(dismissals int64, withinDays, silenceDays float64, exemptTypes []string) Check {
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
			if isCommitment(ctx.Candidate) {
				return passReason("a commitment the person set up; the dismissal cooldown does not apply"), nil
			}
			if contains(exemptTypes, ctx.Candidate.Type) {
				return passReason(fmt.Sprintf("type %q is exempt from the dismissal cooldown", ctx.Candidate.Type)), nil
			}
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
	// Limit is the check's own limit. Nil means the check's default; an explicit
	// zero is a limit of zero (SPEC 9.12).
	Limit          *float64
	BypassPriority Priority
	// NearLimit is the fraction of the limit at which a pass carries a
	// nearLimit note. Default 0.8.
	NearLimit float64
	// Tiers maps a tier name to a limit, read through user.tier (SPEC 9.12).
	Tiers map[string]any
	// UserLimit returns an explicit per-user limit that wins over the tiers.
	// Nil for a check that has none.
	UserLimit func(user *UserState) (float64, bool)
}

// limitAt is a pointer to an explicit limit, for budgetOptions.Limit.
func limitAt(n float64) *float64 { return &n }

// countOf reads a count the way the specification reads one (SPEC 9.11): an
// absent value is zero, a number is itself, a boolean is 1 or 0, a string is
// parsed, and anything else is NaN, which makes a total not finite.
func countOf(v any) float64 {
	if n, ok := numberOf(v); ok {
		return n
	}
	switch x := v.(type) {
	case nil:
		return 0
	case bool:
		if x {
			return 1
		}
		return 0
	case string:
		text := strings.TrimSpace(x)
		if text == "" {
			return 0
		}
		n, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return math.NaN()
		}
		return n
	}
	return math.NaN()
}

// isCount reports whether v is a number of any kind.
func isCount(v any) bool {
	_, ok := numberOf(v)
	return ok
}

// budget builds one counter check: a read at evaluate, an atomic increment at
// commit. The limit in force is the user's explicit override, else the tier
// named in tiers, else the check's own limit (SPEC 9.12).
func budget(id, label string, defaultLimit int64, keyFor func(ctx *CheckContext) (string, error), ttlSeconds int64, o budgetOptions) Check {
	ownLimit := float64(defaultLimit)
	if o.Limit != nil {
		ownLimit = *o.Limit
	}
	nearFraction := o.NearLimit
	if nearFraction == 0 {
		nearFraction = 0.8
	}
	bypass := func(p Priority) bool { return o.BypassPriority != "" && atLeast(p, o.BypassPriority) }
	limitFor := func(ctx *CheckContext) float64 {
		if o.UserLimit != nil {
			if n, ok := o.UserLimit(ctx.User); ok {
				return n
			}
		}
		if tier, ok := o.Tiers[ctx.User.Tier]; ok && isCount(tier) {
			return countOf(tier)
		}
		return ownLimit
	}
	return Check{
		ID: id,
		Run: func(ctx *CheckContext) (Outcome, error) {
			if isCommitment(ctx.Candidate) {
				return passReason("a commitment the person set up; it spends no budget"), nil
			}
			if bypass(ctx.Priority) {
				return pass(), nil
			}
			limit := limitFor(ctx)
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
			if float64(used) >= limit {
				return reject(fmt.Sprintf("%s of %s used (%d)", label, formatNumber(limit), used)), nil
			}
			nearAt := math.Max(1, math.Ceil(limit*nearFraction))
			if float64(used) >= nearAt {
				return Outcome{Kind: OutcomePass, Reason: fmt.Sprintf("%d of %s used", used, formatNumber(limit)), NearLimit: &NearLimit{Used: used, Limit: int64(limit)}}, nil
			}
			return pass(), nil
		},
		Consume: func(ctx *CheckContext) (bool, error) {
			if isCommitment(ctx.Candidate) || bypass(ctx.Priority) {
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
			return float64(used) <= limitFor(ctx), nil
		},
	}
}

// dailyOverride is user.dailyLimit when it is a finite number of at least 0.
// An explicit override always wins over the tiers (SPEC 9.12).
func dailyOverride(user *UserState) (float64, bool) {
	n, ok := numberOf(user.DailyLimit)
	if !ok || math.IsNaN(n) || math.IsInf(n, 0) || n < 0 {
		return 0, false
	}
	return n, true
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

// resetsWhenKeyChanges answers NextAllowedAt for a counter keyed by local day,
// ISO week or month: the counter starts again at the first minute at which its
// key differs (SPEC 3.7).
func resetsWhenKeyChanges(keyFor func(userID string, now time.Time, timezone string) (string, error)) func(ctx *CheckContext) (*time.Time, error) {
	return func(ctx *CheckContext) (*time.Time, error) {
		zone := effectiveZone(ctx.User)
		return nextKeyChange(ctx.Now, zone, func(at time.Time) (string, error) {
			return keyFor(ctx.User.ID, at, zone)
		})
	}
}

// dailyBudget allows at most limit deliveries per user per local day. A
// user's dailyLimit overrides both the tiers and the limit (SPEC 9.12).
func dailyBudget(o budgetOptions) Check {
	o.UserLimit = dailyOverride
	c := budget("dailyBudget", "daily budget", 5,
		func(ctx *CheckContext) (string, error) {
			return budgetKey(ctx.User.ID, ctx.Now, effectiveZone(ctx.User))
		},
		2*daySeconds, o)
	c.NextAllowedAt = resetsWhenKeyChanges(budgetKey)
	return c
}

// weeklyBudget allows at most limit deliveries per user per local ISO week.
// The counter resets on Monday morning in the user's zone.
func weeklyBudget(o budgetOptions) Check {
	c := budget("weeklyBudget", "weekly budget", 20,
		func(ctx *CheckContext) (string, error) {
			return weeklyBudgetKey(ctx.User.ID, ctx.Now, effectiveZone(ctx.User))
		},
		8*daySeconds, o)
	c.NextAllowedAt = resetsWhenKeyChanges(weeklyBudgetKey)
	return c
}

// monthlyBudget allows at most limit deliveries per user per local calendar
// month.
func monthlyBudget(o budgetOptions) Check {
	c := budget("monthlyBudget", "monthly budget", 60,
		func(ctx *CheckContext) (string, error) {
			return monthlyBudgetKey(ctx.User.ID, ctx.Now, effectiveZone(ctx.User))
		},
		32*daySeconds, o)
	c.NextAllowedAt = resetsWhenKeyChanges(monthlyBudgetKey)
	return c
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

// zoneOf is the zone a check reads: the user's effective zone for "user", else
// the zone the policy names.
func zoneOf(ctx *CheckContext, timezone string) string {
	if timezone == "user" {
		return effectiveZone(ctx.User)
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
	return requiresConsentExempt(name, when, whenZone, id, false)
}

// requiresConsentExempt is requiresConsent with exemptTransactional (SPEC 9.7):
// when set, a candidate that is not promotional passes without the consent.
func requiresConsentExempt(name string, when *QuietWindow, whenZone string, id string, exemptTransactional bool) (Check, error) {
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
			if exemptTransactional {
				if why := notPromotional(ctx.Candidate); why != "" {
					return passReason(fmt.Sprintf("%s; not promotional, so consent %q is not required", why, name)), nil
				}
			}
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
		budgetOptions{Limit: limitAt(float64(limit)), NearLimit: 1})
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
		budgetOptions{Limit: limitAt(float64(limit)), NearLimit: 1})
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

/* ------------------------------------------------------------------------ */
/* The 1.6.0 checks (SPEC 9.8 to 9.11).                                      */
/* ------------------------------------------------------------------------ */

// crisisQuiet rejects every candidate while the user is in a crisis quiet
// period, except crisis support. It spends nothing, and it is meant to run
// first (SPEC 9.10).
func crisisQuiet() Check {
	return Check{
		ID: "crisisQuiet",
		Run: func(ctx *CheckContext) (Outcome, error) {
			until := parseInstant(ctx.User.CrisisUntil)
			if until == nil || !until.After(ctx.Now) || ctx.Candidate.Kind == "support" {
				return pass(), nil
			}
			return reject(fmt.Sprintf("crisis quiet period until %s; only support messages pass", isoMillis(*until))), nil
		},
		NextAllowedAt: func(ctx *CheckContext) (*time.Time, error) {
			return parseInstant(ctx.User.CrisisUntil), nil
		},
	}
}

// freshness refuses stale content (SPEC 9.8). With maxAge set it also refuses
// content created more than maxAge seconds before now.
func freshness(maxAge *float64) Check {
	return Check{
		ID: "freshness",
		Run: func(ctx *CheckContext) (Outcome, error) {
			// A nil or zero instant is absent (SPEC 9.1.1, 9.8): it neither rejects nor counts as present.
			c := ctx.Candidate
			_, hasUntil, _ := instantOf(c.FreshUntil)
			_, hasCreated, _ := instantOf(c.CreatedAt)
			if !hasUntil && !(hasCreated && maxAge != nil) {
				if hasCreated {
					return skip("no maxAgeSeconds set; createdAt is not checked"), nil
				}
				return skip("no freshUntil or createdAt on the candidate; freshness cannot be evaluated"), nil
			}
			if hasUntil {
				until, _, ok := instantOf(c.FreshUntil)
				if !ok {
					return reject("freshUntil is not a valid instant; treated as expired"), nil
				}
				if !until.After(ctx.Now) {
					return reject(fmt.Sprintf("expired at %s", isoMillis(until))), nil
				}
			}
			if hasCreated && maxAge != nil {
				created, _, ok := instantOf(c.CreatedAt)
				if !ok {
					return reject("createdAt is not a valid instant; treated as expired"), nil
				}
				if ctx.Now.Sub(created).Seconds() > *maxAge {
					return reject(fmt.Sprintf("expired: created %s, older than %s seconds", isoMillis(created), formatNumber(*maxAge))), nil
				}
			}
			return pass(), nil
		},
	}
}

// silence refuses a candidate whose caller-supplied evidence is too thin (SPEC
// 9.9). The gate never fills evidence, and a candidate without it is skipped.
func silence(minDataPoints, minConfidence float64, requireNew bool) Check {
	return Check{
		ID: "silence",
		Run: func(ctx *CheckContext) (Outcome, error) {
			if ctx.Candidate.Evidence == nil {
				return skip("no evidence on the candidate; silence cannot be evaluated"), nil
			}
			data := ctx.Candidate.Evidence
			points := evidenceCount(fieldOf(data, "dataPoints"))
			if points < minDataPoints {
				return reject(fmt.Sprintf("not enough data: %s data points, need %s", formatNumber(points), formatNumber(minDataPoints))), nil
			}
			confidence := evidenceCount(fieldOf(data, "confidence"))
			if confidence < minConfidence {
				return reject(fmt.Sprintf("not enough confidence: %s, need %s", formatNumber(confidence), formatNumber(minConfidence))), nil
			}
			if newSinceLast, ok := fieldOf(data, "newSinceLast").(bool); requireNew && ok && !newSinceLast {
				return reject("nothing new since the last message"), nil
			}
			return pass(), nil
		},
	}
}

// deadHours takes push off the table in an hour when the user acted on too
// little of what they were sent then (SPEC 9.11). It never rejects. The counts
// are the user's hourStats entry for the hour when the caller gave one, else the
// counters Gate.Record wrote.
func deadHours(minSamples, maxActRate float64, minPriority Priority) Check {
	judged := func(ctx *CheckContext) bool {
		return contains(ctx.Surfaces, "push") && !atLeast(ctx.Priority, minPriority)
	}
	return Check{
		ID:           "deadHours",
		NonRejecting: true,
		Run: func(ctx *CheckContext) (Outcome, error) {
			if !judged(ctx) {
				return pass(), nil
			}
			hour := hourOfDay(ctx.Now, effectiveZone(ctx.User))
			acted, dismissed, err := hourCounts(ctx, hour)
			if err != nil {
				return Outcome{}, err
			}
			total := acted + dismissed
			if math.IsNaN(total) || math.IsInf(total, 0) || total == 0 || total < minSamples || acted/total >= maxActRate {
				return pass(), nil
			}
			surfaces := make([]string, 0, len(ctx.Surfaces))
			for _, s := range ctx.Surfaces {
				if s != "push" {
					surfaces = append(surfaces, s)
				}
			}
			return Outcome{
				Kind:     OutcomeAdjust,
				Reason:   fmt.Sprintf("dead hour %d:00: %s of %s acted on; push removed for %s", hour, formatNumber(acted), formatNumber(total), ctx.Candidate.ID),
				Surfaces: surfaces,
			}, nil
		},
	}
}

// hourCounts returns the acted and dismissed counts for one local hour: the
// user's own entry when present, else the stored counters.
func hourCounts(ctx *CheckContext, hour int) (acted, dismissed float64, err error) {
	if stats, ok := ctx.User.HourStats.(map[string]any); ok {
		if entry := stats[strconv.Itoa(hour)]; entry != nil {
			m, _ := entry.(map[string]any)
			return countOf(m["acted"]), countOf(m["dismissed"]), nil
		}
	}
	read := func(outcome string) (float64, error) {
		raw, ok, err := ctx.Store.Get(hoursKey(ctx.User.ID, hour, outcome))
		if err != nil || !ok {
			return 0, err
		}
		return countOf(raw), nil
	}
	if acted, err = read("acted"); err != nil {
		return 0, 0, err
	}
	if dismissed, err = read("dismissed"); err != nil {
		return 0, 0, err
	}
	return acted, dismissed, nil
}

// hoursKey is the store key of one local hour's acted or dismissed count.
func hoursKey(userID string, hour int, outcome string) string {
	return "hours:" + userID + ":" + strconv.Itoa(hour) + ":" + outcome
}

// hourOfDay is the local hour, 0 to 23, in zone, or the UTC hour when the zone
// is empty (SPEC 9.11).
func hourOfDay(now time.Time, zone string) int {
	if zone == "" {
		return now.UTC().Hour()
	}
	minutes, _, err := localClock(now, zone)
	if err != nil {
		return now.UTC().Hour()
	}
	return minutes / 60
}
