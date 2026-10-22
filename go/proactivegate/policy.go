package proactivegate

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Policy is a JSON policy document (spec/schema/policy.schema.json): the same
// checks as data.
type Policy struct {
	SpecVersion  string        `json:"specVersion"`
	OnStoreError string        `json:"onStoreError"`
	KeyPrefix    string        `json:"keyPrefix"`
	Checks       []PolicyEntry `json:"checks"`
}

// PolicyEntry is one entry of the checks array: either { "id": <check> } or
// { "preset": <name> }, each with options and an optional "shadow" flag.
type PolicyEntry map[string]any

const supportedMajor = 1

type options map[string]any

func (o options) num(key string) float64 {
	if v, ok := o[key].(float64); ok {
		return v
	}
	return 0
}

func (o options) str(key string) string {
	if v, ok := o[key].(string); ok {
		return v
	}
	return ""
}

func (o options) bool(key string) bool {
	v, _ := o[key].(bool)
	return v
}

func (o options) strs(key string) []string {
	list, ok := o[key].([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(list))
	for _, v := range list {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// failMode reads consent's failMode object (SPEC 9.3). A value that is not a
// string is kept as "", which is not "open", so it stays closed.
func (o options) failMode() map[string]string {
	raw, ok := o["failMode"].(map[string]any)
	if !ok {
		return nil
	}
	out := make(map[string]string, len(raw))
	for surface, v := range raw {
		s, _ := v.(string)
		out[surface] = s
	}
	return out
}

func (o options) prio(key string) Priority {
	if v, ok := o[key].(string); ok {
		return Priority(v)
	}
	return ""
}

// numOr is the number under key, or def when the key is absent or not a number.
func (o options) numOr(key string, def float64) float64 {
	if v, ok := o[key].(float64); ok {
		return v
	}
	return def
}

func (o options) budgetOptions() budgetOptions {
	out := budgetOptions{
		BypassPriority: o.prio("bypassPriority"),
		NearLimit:      o.num("nearLimit"),
	}
	if n, ok := o["limit"].(float64); ok {
		out.Limit = limitAt(n)
	}
	if tiers, ok := o["tiers"].(map[string]any); ok {
		out.Tiers = tiers
	}
	return out
}

// knownChecks is every check a JSON policy may name, with the options it reads.
var knownChecks = map[string]func(options) (Check, error){
	"killSwitch": func(o options) (Check, error) {
		raw, hasFlag := o["flag"]
		if !hasFlag {
			return killSwitch(o.bool("on")), nil
		}
		if _, hasOn := o["on"]; hasOn {
			return Check{}, fmt.Errorf(`killSwitch takes "on" or "flag", not both`)
		}
		name, isString := raw.(string)
		if !isString {
			return Check{}, fmt.Errorf(`killSwitch "flag" must be a string, not %v`, raw)
		}
		return killSwitchFlag(name), nil
	},
	"consent": func(o options) (Check, error) { return consent(o.failMode()), nil },
	"enabled": func(o options) (Check, error) { return enabled(), nil },
	"mode": func(o options) (Check, error) {
		allow := o.strs("allow")
		if allow == nil {
			allow = []string{"normal"}
		}
		return mode(allow), nil
	},
	"snooze": func(o options) (Check, error) { return snooze(o.bool("defer")), nil },
	"mute":   func(o options) (Check, error) { return mute(), nil },
	"intensity": func(o options) (Check, error) {
		var floors map[string]Priority
		if raw, ok := o["floors"].(map[string]any); ok {
			floors = map[string]Priority{}
			for k, v := range raw {
				if s, ok := v.(string); ok {
					floors[k] = Priority(s)
				}
			}
		}
		return intensity(floors), nil
	},
	"quietHours": func(o options) (Check, error) {
		missing := "skip"
		if raw, ok := o["onMissingTimezone"]; ok {
			s, isString := raw.(string)
			if !isString || (s != "skip" && s != "reject") {
				return Check{}, fmt.Errorf(`quietHours onMissingTimezone must be "skip" or "reject", not %v`, raw)
			}
			missing = s
		}
		return quietHours(o.prio("priorityFloor"), missing), nil
	},
	"trustRamp": func(o options) (Check, error) {
		return trustRamp(o.num("days"), o.prio("minPriority")), nil
	},
	"dismissalCooldown": func(o options) (Check, error) {
		return dismissalCooldown(int64(o.num("dismissals")), o.num("withinDays"), o.num("silenceDays"), o.strs("exemptTypes")), nil
	},
	"crisisQuiet": func(o options) (Check, error) { return crisisQuiet(), nil },
	"freshness": func(o options) (Check, error) {
		var maxAge *float64
		if v, ok := o["maxAgeSeconds"].(float64); ok {
			maxAge = &v
		}
		return freshness(maxAge), nil
	},
	"silence": func(o options) (Check, error) {
		requireNew := true
		if v, ok := o["requireNew"].(bool); ok {
			requireNew = v
		}
		return silence(o.numOr("minDataPoints", 5), o.numOr("minConfidence", 0.5), requireNew), nil
	},
	"deadHours": func(o options) (Check, error) {
		minPriority := o.prio("minPriority")
		if minPriority == "" {
			minPriority = PriorityHigh
		}
		return deadHours(o.numOr("minSamples", 5), o.numOr("maxActRate", 0.2), minPriority), nil
	},
	"adaptiveTiming": func(o options) (Check, error) { return adaptiveTiming(), nil },
	"dedupe":         func(o options) (Check, error) { return dedupe(int64(o.num("windowSeconds"))), nil },
	"dailyBudget":    func(o options) (Check, error) { return dailyBudget(o.budgetOptions()), nil },
	"weeklyBudget":   func(o options) (Check, error) { return weeklyBudget(o.budgetOptions()), nil },
	"monthlyBudget":  func(o options) (Check, error) { return monthlyBudget(o.budgetOptions()), nil },
	"utilityFloor": func(o options) (Check, error) {
		cfa, cfn := o.num("costFalseAlarm"), o.num("costMissedHelp")
		if cfa == 0 {
			cfa = 1
		}
		if cfn == 0 {
			cfn = 1
		}
		return utilityFloor(cfa, cfn), nil
	},
	"boundedDeferral": func(o options) (Check, error) {
		return boundedDeferral(o.num("lambda"), o.num("interruptCost"), o.num("staleness"), o.num("boundSeconds")), nil
	},
	"allowedWindow": func(o options) (Check, error) {
		start, end, timezone := o.str("start"), o.str("end"), o.str("timezone")
		if start == "" {
			start = "08:00"
		}
		if end == "" {
			end = "21:00"
		}
		if timezone == "" {
			timezone = "user"
		}
		return allowedWindow(start, end, timezone, o.prio("priorityFloor"), o.str("id"))
	},
	"requiresConsent": func(o options) (Check, error) {
		name := o.str("name")
		if name == "" {
			name = "consent"
		}
		var when *QuietWindow
		var whenZone string
		if raw, ok := o["when"].(map[string]any); ok {
			wo := options(raw)
			when = &QuietWindow{Start: wo.str("start"), End: wo.str("end")}
			whenZone = wo.str("timezone")
		}
		return requiresConsentExempt(name, when, whenZone, o.str("id"), o.bool("exemptTransactional"))
	},
	"rateLimit": func(o options) (Check, error) {
		// An absent limit is 1; an explicit 0 allows nothing (SPEC 9.12, as in TypeScript and Python).
		limit, perSeconds := int64(o.numOr("limit", 1)), int64(o.num("perSeconds"))
		if perSeconds == 0 {
			perSeconds = 1
		}
		return rateLimit(limit, perSeconds, o.str("keyBy"), o.str("id")), nil
	},
	"recentInteraction": func(o options) (Check, error) {
		within := o.num("withinHours")
		if within == 0 {
			within = 48
		}
		return recentInteraction(within), nil
	},
	"windowBudget": func(o options) (Check, error) {
		// An absent limit is 1; an explicit 0 allows nothing, as in TypeScript and Python.
		limit, within := int64(o.numOr("limit", 1)), o.num("withinHours")
		if within == 0 {
			within = 48
		}
		return windowBudget(limit, within), nil
	},
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// CompilePolicy compiles a JSON policy into gate options. It errors on an
// unsupported specVersion, an unknown check id or an unknown preset name,
// naming the known ids (7.3).
func CompilePolicy(policy *Policy) (GateOptions, error) {
	major, err := strconv.Atoi(strings.SplitN(policy.SpecVersion, ".", 2)[0])
	if err != nil || major != supportedMajor {
		return GateOptions{}, fmt.Errorf("policy specVersion %s is not supported; this package implements spec %d.x", policy.SpecVersion, supportedMajor)
	}
	if len(policy.Checks) == 0 {
		return GateOptions{}, fmt.Errorf("policy.checks must be a non-empty array")
	}
	var compiled []Check
	for _, entry := range policy.Checks {
		shadow, _ := entry["shadow"].(bool)
		rest := options(entry)
		delete(rest, "shadow")
		var built []Check
		if presetName, ok := rest["preset"].(string); ok {
			preset, known := Presets[presetName]
			if !known {
				return GateOptions{}, fmt.Errorf("unknown preset %q; known presets: %s", presetName, strings.Join(sortedKeys(Presets), ", "))
			}
			delete(rest, "preset")
			built, err = preset.Build(rest)
			if err != nil {
				return GateOptions{}, err
			}
		} else if id, ok := rest["id"].(string); ok {
			factory, known := knownChecks[id]
			if !known {
				return GateOptions{}, fmt.Errorf("unknown check %q; known checks: %s", id, strings.Join(sortedKeys(knownChecks), ", "))
			}
			delete(rest, "id")
			c, err := factory(rest)
			if err != nil {
				return GateOptions{}, err
			}
			built = []Check{c}
		} else {
			return GateOptions{}, fmt.Errorf("each policy entry needs an id or a preset")
		}
		if shadow {
			for i := range built {
				built[i].Shadow = true
			}
		}
		compiled = append(compiled, built...)
	}
	return GateOptions{
		Checks:       compiled,
		OnStoreError: policy.OnStoreError,
		KeyPrefix:    policy.KeyPrefix,
	}, nil
}

// NewGateFromPolicy compiles a JSON policy document and binds it to store.
// A nil store means a fresh MemoryStore.
func NewGateFromPolicy(policy *Policy, store Store) (*Gate, error) {
	opts, err := CompilePolicy(policy)
	if err != nil {
		return nil, err
	}
	opts.Store = store
	return NewGate(opts), nil
}
