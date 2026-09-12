# The adversarial clock suite

Design, 12 September 2026. Status: design committed before the suite is run. The results
section at the end is appended after the run, with the commands and versions that produced it.

Issue #21 asks for a fixture set of hostile moments: the days that break notification
policies. Every decision this library makes is a function of `now`, and the only clock
coverage the suite had was the cases somebody happened to think of. The benchmark found one
by thinking of it: `bench/naive.mjs` keys its daily cap on the UTC day, which hands one user
a second allowance and silences another for nine hours. This document is the systematic
version of that thought.

## 1. What is being built

One fixture per hostile moment under `spec/fixtures/clock/`, the same fixture format the
rest of the suite uses, so the TypeScript and Python implementations are both held to every
case and a third implementation inherits the suite for free. Each fixture's `description`
and each test's `description` state what the correct behaviour is and why, in terms of
`spec/SPEC.md` clauses where one applies.

Where an implementation's current behaviour differs from the expected outcome, the fixture
keeps the expected outcome and the implementation's `spec/skip/<impl>.txt` gains a line
naming the filed issue. That is the issue's own rule: land the expected behaviour, mark it
failing, do not pick a winner quietly. Where the two implementations disagree with each
other, the disagreement is the finding and is reported in the results section, whether or
not a fixture can express it.

No check, policy, default or existing fixture changes. `SPEC_VERSION` moves once, to
1.4.1: when this design was written 1.4.0 was untagged and the fixtures would have
arrived in it, but the 0.7.0 release tagged `spec/v1.4.0` before the suite landed, and a
tagged version takes no new fixtures. The bump is a patch on the spec's own versioning
rule, which reserves minor for additions to the vocabulary; these are twenty-one fixtures
against checks that already exist, and the skips declare implementation failures, not a
change to the spec. Existing fixtures keep their `since`; the twenty-one below arrive in
1.4.1.

## 2. The hostile moments

The issue's list, each mapped to the check or checks it stresses:

- **The deleted hour.** A quiet window that opens inside the hour a spring forward deletes
  can never contain a real local time, so it is empty for one day a year. New York loses
  02:00 to 03:00 on 2026-03-08; Lord Howe loses only thirty minutes on 2026-10-04, which
  also exercises an `HH:MM` window finer than the usual hour grain.
- **The repeated hour.** A fall back plays 01:00 to 02:00 twice in New York on 2026-11-01.
  A one-hour window silences for ninety real minutes, and both passes through the repeated
  hour are quiet.
- **A window that crosses midnight on the night the clock also changes.** Quiet hours
  22:00 to 02:30 resolved for 2026-03-07 end early, because 02:30 never arrives: the last
  quiet minute is 01:59:59 EST and 03:00 EDT is already outside. The same window over the
  autumn transition runs five real hours, because its four hours contain a repeated one.
- **The 23-hour and 25-hour days.** A daily budget keyed on the local day (5.1) spends its
  counter over 23 real hours on 2026-03-08 and 25 on 2026-11-01. The key is a calendar
  date, so the budget neither refunds the missing hour nor charges for the extra one; the
  boundary instants pin that.
- **A timezone change mid-week.** The weekly key is the ISO week of the local day *in the
  zone the input carries*. 2026-09-13T23:30Z is Sunday 19:30 in New York, inside
  `2026-W37`, and Monday 12:30 in Apia, inside `2026-W38`. A user who spent their budget in
  one zone and moved to the other has, conformingly, a fresh allowance; the fixture pins
  both key names through `store_after` so neither implementation can quietly compute a
  different week.
- **Offsets that are not whole hours.** Kathmandu is UTC+5:45, so its midnight falls at
  18:15 UTC and a budget's local day turns over at a quarter past the hour. Chatham is
  +12:45 and springs forward at 02:45 local, deleting an hour that starts at a :45.
  `Etc/GMT+5` is the POSIX-inverted name for UTC-5, which a sign-confused reader turns into
  +5. And 6.6 requires the weekday to come from the local calendar date, never from the
  instant: 2026-09-04T18:30Z is Friday in UTC and already Saturday in Kathmandu.
- **Zones that changed their rules.** Mexico City stopped observing daylight saving after
  2022, so the first Sunday of April 2026 is an ordinary day there and a quiet window at
  02:00 still runs. Istanbul made the same change in 2016. Casablanca observes Ramadan:
  UTC+1 most of the year, UTC+0 inside it, so the zone "falls back" in February and springs
  forward in March.
- **A day that never existed.** Pacific/Apia skipped 2011-12-30 entirely; 23:59:59 on the
  29th is followed by 00:00 on the 31st. A `dates` entry naming 2011-12-30 is dead
  configuration, a `days` entry for Friday has no Friday to land on that week, and a daily
  budget key for the skipped day can never be written. The property tests already carry
  Apia for this reason; the fixture turns the anecdote into contract.
- **The ISO week that belongs to another year.** 2025-12-31 is in 2026-W01 and 2027-01-01
  is in 2026-W53. A weekly key that mixes the calendar year of the local date with the
  week number produces both a phantom week and a split week; the fixtures pin the
  `<YYYY>-W<WW>` strings through `store_after`.
- **Leap day.** 2028-02-29 exists once in four years: a daily key for it, a monthly key
  that still covers it, and a crossing-midnight window resolved for it must reach into
  2028-03-01 through `dayBefore`, which is the clause most likely to be implemented as
  instant arithmetic.
- **The leap second.** 2016-12-31T23:59:60Z happened and neither platform can say it: V8
  reads it as an invalid `Date` and `datetime.fromisoformat` rejects seconds past 59. No
  `now` can carry it, so no fixture can either; the record is this section and a fixture
  asserting that a timestamp *field* holding 23:59:60 degrades to absent rather than
  crashing the gate. A null result, published where a positive one would go.
- **The clock that goes backwards.** `now` is caller-supplied and a wall clock rewinds:
  NTP steps, restored snapshots, hand-set devices. The store keeps the truth across tests
  inside one fixture, so a dedupe key claimed at 12:00 is still claimed when `now` reports
  11:00, and a budget spent "in the future" is still spent when the clock rewinds past it.
- **Timestamps from the future.** The same rewind seen from the other side: a
  `lastInboundAt` later than `now` is a negative age, which `recentInteraction` passes and
  future dismissal stamps still silence under `dismissalCooldown`, because both compare
  instants rather than ask how the stamps got there.
- **A year under 1000.** `Intl.DateTimeFormat` with `year: "numeric"` pads nothing, so the
  local day of an instant in year 1 renders as `1-06-01`, and `Date.UTC` reads years 0 to
  99 as 1900 to 1999. Python's `strftime("%Y")` emits `0001`, and its ISO week key formats
  the year unpadded. Whether any of this survives contact with the actual implementations
  is what the run will show; the fixture asserts the `YYYY-MM-DD` and `YYYY-Www` forms 5.1
  writes down.
- **A zone nobody knows.** `Mars/Olympus_Mons` is a legal string that no tzdb resolves.
  3.5 says a throwing check is a `skip` under the default fail-open mode, so the decision
  is allowed and the trace shows why. The two implementations throw in different places
  (inside `run` for TypeScript, inside `keys` for Python's store-read path), which makes
  this the cheapest test that the error contract, not just the happy path, is shared.

Each fixture names its checks. Collectively the suite touches every check that consults
the clock: `quietHours`, `allowedWindow`, `requiresConsent` (its `when` window),
`dailyBudget`, `weeklyBudget`, `monthlyBudget`, `dedupe`, `snooze`, `trustRamp`,
`dismissalCooldown`, `recentInteraction`, `windowBudget` and `rateLimit`. The remaining
checks read no time or read it only to move `deliverAt` by an offset (`boundedDeferral`,
`adaptiveTiming`), which the sweep below confirms is zone-free. One fixture additionally
runs a hostile instant through the full default battery, so an interaction between checks
cannot hide behind a two-check policy.

## 3. How the moments were searched for

Two sweeps, both committed so the numbers in the results section are reproducible:

1. `bench/clock-sweep.mjs` and `bench/clock-sweep.py` render the local time of the same
   instant through each implementation's tz data (`Intl` against `zoneinfo`) for a list of
   (zone, instant) pairs: twenty-five zones chosen for having unusual offsets or recently
   changed rules, sampled twice daily across 2011 to 2029 plus fifteen-minute sweeps over
   every known transition. Diffing the outputs finds every instant where the two
   implementations would resolve a different local minute or day, which is where the two
   tzdb vintages disagree, before any fixture is written.
2. The pure functions behind the keys, `weekdayOf`, `dayBefore` and `isoWeekKey` against
   their Python siblings, over every day from 1990 to 2035, plus a probe of the
   sub-1000 range where the formatting rules change.

The sweeps find divergences; the fixtures pin the ones a policy can reach. A divergence the
fixture format cannot express (a `now` that a runner cannot parse) is recorded in the
results rather than forced into a shape the suite cannot check.

## 4. How expected behaviour is decided

`spec/SPEC.md` first: 5.1 names the key formats, 6.1 through 6.6 pin the local-day,
window-resolution, precedence and weekday rules, 3.5 covers the throwing check. Where the
spec is silent, the expected behaviour is the one that does not surprise the user the
policy exists to protect, and the fixture's description says the spec was silent. Where
even that is arguable (a week key for year 1), the spec's written format is the
expectation and both implementations wear the skip until the spec or the code moves.

One caution is designed in: **a fixture must not pin an answer only one tzdb vintage
produces.** Where the sweep shows the two runtimes already disagree, pinning either side
would be picking a winner by version number. Such a divergence is reported in the results
and filed as its own issue; the fixtures that touch recently changed zones use instants
every plausible vintage agrees on.

## 5. What a null result means

If every fixture passes on both implementations, the suite has demonstrated, rather than
asserted, that the clock rules in section 6 survive the worst days the tz database knows.
That is a publishable result for a conformance corpus, the same way the empty diff of the
pure-function sweep is one. The failure mode this design refuses is a suite that finds
nothing because it never asked; the sweeps exist so that "nothing found" means something.

## 6. Threats

- tzdb vintage is not pinned by the spec, the package or CI; a fixture pinned on a date
  where vintages disagree is a coin flip on another machine. Mitigation is in section 4.
- Python's `strftime("%Y")` for years under 1000 is libc-dependent; the assertions here are
  generated on glibc, and CI runs Ubuntu, which is also glibc.
- A fixture's `store_seed` cannot carry a TTL, so expiry-under-a-rewound-clock is asserted
  at the evaluation level; the stores' own clocks are a store-contract matter and are noted
  in the results as a boundary of what this suite can see.
- The property tests and this suite share no code, so a bug in both would need the same
  mistake made twice independently. Possible, and the reason the sweep scripts are separate
  small programs rather than calls into the library.

## Results

Run on 12 September 2026.

### Commands and versions

```sh
python3 bench/clock-sweep-pairs.py | node bench/clock-sweep.mjs   | sort > /tmp/clock-node.txt
python3 bench/clock-sweep-pairs.py | python3 bench/clock-sweep.py | sort > /tmp/clock-py.txt
diff /tmp/clock-node.txt /tmp/clock-py.txt

npm run build
node dist/src/cli.js replay --fixtures spec/fixtures/clock --skip spec/skip/ts.txt
PYTHONPATH=python/src python3 -m pytest python/tests/test_conformance.py
node scripts/conformance-table.mjs
```

Runtimes on the machine that produced these numbers:

- Node v24.14.0, ICU 78.2, embedded tz data 2025c.
- Python 3.14.4, system `zoneinfo` against system tzdb 2026c (no `tzdata` wheel installed).
- Python 3.13.13 in the project venv (uv, python-build-standalone), where
  `strftime("%Y")` does not zero-pad the year: two Pythons on one machine disagree about
  the local-day string for year 1, which is finding 3 below.

The tzdb vintage mismatch is deliberate context, not an accident to hide: it is exactly the
"recently changed rules" hazard the suite exists to surface, and the results below report
rather than paper over it.

### The sweep

364,110 (zone, instant) pairs were rendered by each implementation. The outputs differ on
4,340 rows, all in `Africa/Casablanca` and `Africa/El_Aaiun`, first divergence at
2026-09-20T12:00:00Z, last at the sweep horizon 2029-12-30T00:00:00Z. At
2026-09-20T12:00:00Z Node reads 13:00 (+1) where Python reads 12:00 (+0): tzdb 2026c moved
Morocco's post-2026 schedule, and 2025c does not know about it. The diffs pause inside each
Ramadan window, where both vintages read +0.

This disagreement is decision-relevant, not cosmetic: a `12:00` to `13:00` quiet window at
that instant rejects under 2025c and passes under 2026c. No fixture pins it, because there
is no implementation-independent right answer at those instants; picking either side would
be choosing a tzdb version, not specifying behaviour. The fixture
`clock/recently-changed-rules` uses instants every plausible vintage agrees on and its
description says so. The disagreement itself is reported here and is a reproducibility
property of the environment: two conforming implementations on different tzdb vintages
will decide differently inside the disputed span, which is an argument for the spec naming
a minimum tzdb vintage, a spec change this PR does not make.

The day-level sweep of `weekdayOf`, `dayBefore` and the ISO week key against their Python
siblings over every day from 1990 to 2035 produced an empty diff.

### The fixtures

Twenty-one fixtures under `spec/fixtures/clock/` were added, listed by the conformance
table. Outcomes on this machine:

- TypeScript: 19 pass, 2 declared skips (`clock/year-under-1000`,
  `clock/year-under-1000-week`).
- Python: 19 pass under the venv interpreter, 20 under the system one, 2 declared skips
  (`clock/year-under-1000`, `clock/year-under-1000-week`) either way, because the verdict
  on the first is build-dependent.

The skip declarations are per-implementation and asymmetric, which is itself the finding:
`clock/year-under-1000` passes only where `strftime("%Y")` happens to pad.

### What the suite found

1. **Years below 1000 break TypeScript calendar arithmetic** (upstream bug
   [#36](https://github.com/Bubblegunn/proactive-gate/issues/36)). `localClock` emits the
   local day unpadded (`1-06-01`), `Date.UTC` then reads years 0 to 99 as 1900 to 1999, so
   `weekdayOf` answers for 1901, `dayBefore` produces `1901-05-31`, `dates` lookups miss,
   and `isoWeekKey` parses an invalid date and emits the literal key `NaN-WNaN`. A Friday
   quiet window is silent on a Friday in year 1 and a spent daily budget reads fresh.
2. **Python pads the daily key but not the weekly key** (upstream bug
   [#37](https://github.com/Bubblegunn/proactive-gate/issues/37)). The same instant
   produces `budget:u:0001-06-01` and `weeklyBudget:u:1-W22`; the spec format reads the
   year padded, so the fixture expects `0001-W22` and the skip records the divergence.
3. **Python's year padding is build-dependent, and the failure mode is silent**
   (upstream bug [#38](https://github.com/Bubblegunn/proactive-gate/issues/38)). On the
   non-padding build, `local_clock` emits `1-06-01`, the strict-ISO `weekday_of`,
   `day_before` and `iso_week_key` all raise on it, and every clock check is recorded as
   a fail-open skip: the day goes quiet with nothing rejecting. Two interpreters on one
   machine produced different decisions for the same fixture, which is the closest this
   suite comes to the issue's "silently make incorrect decisions".
4. **A tzdb-vintage divergence that no implementation can fix alone**, described in the
   sweep section. It is the one disagreement where "expected behaviour" is genuinely
   undefined by the spec, and it is reported rather than pinned.
5. **Confirmed correct on both sides**, the null results the suite exists to prove: a
   deleted-hour window never fires and a truncated window ends early; the repeated hour
   silences both passes (a 60-minute window for 90 real minutes, a four-hour window for
   five); a skipped calendar day leaves its `dates` entry dead while the plain overnight
   window keeps running and even names the missing day as its opener; budgets key on the
   local day across 23- and 25-hour days and across a mid-week zone move; ISO week-year
   edges resolve to the neighbouring year's key; `now` moving backwards cannot un-claim a
   dedupe key or un-spend a budget; future timestamps degrade predictably (negative ages
   pass lookbacks, future dismissal stamps silence); a `23:59:60` field parses to absent
   in both runtimes; an unresolvable zone fails open identically; and the epoch-keyed
   checks (`rateLimit`, `windowBudget`, `boundedDeferral`) are provably zone-free.

### Boundaries of what the suite can see

- Store TTLs run on real elapsed time in `MemoryStore`, so fixture-level assertions about
  a rewound clock cover the decision records (claims, counters, cooldowns), not key
  expiry; stores whose TTL source is the rewound clock are a store-contract question.
- The 4,340 sweep rows are version-dependent by construction: on a host where Node's tz
  data is 2026c or later the sweep diff is expected to shrink to zero.
- `clock/year-under-1000*` asserts the spec format for a case the spec never discusses
  explicitly; if the spec is amended to bless unpadded years, the fixtures and skips
  change together.
- `scripts/explain-parity.mjs` changed in the same PR, for honesty rather than coverage:
  a fixture either side has declared a skip on can no longer yield identical decisions,
  so the comparison now excludes declared-skip fixtures (announced in its output), and the
  `check failed with "..."` sentences quote each runtime's own exception text, so the
  quoted payload is normalised before comparing while the template around it is still
  held identical.

