# Changelog

## 0.7.1 (2026-09-12)

**An adversarial clock suite, and the two bugs it found in our own code.**
[@LouisDeconinck](https://github.com/LouisDeconinck) contributed twenty one fixtures for the days a
clock misbehaves ([#39](https://github.com/Bubblegunn/proactive-gate/pull/39), closing
[#21](https://github.com/Bubblegunn/proactive-gate/issues/21)): deleted and repeated daylight saving
hours, 23 and 25 hour local days, a mid week timezone move, non hour offsets, Apia's skipped calendar
day, ISO week years that are not the calendar year, a rewound clock, and years below 1000. Seventeen
of them agree across both implementations, which is the null result the study was designed to be able
to report.

Two did not, and the fixtures were merged with both implementations declaring the failure rather than
with the fixtures adjusted to pass. Fixed here:

- **`localClock` formatted years below 1000 unpadded**, so the local day read `1-06-01`
  ([#36](https://github.com/Bubblegunn/proactive-gate/issues/36)). Three separate `Date.UTC(y, ...)`
  calls then read that year as an offset from 1900, so `weekdayOf` answered for the wrong century,
  `dayBefore` missed, and the ISO week arithmetic subtracted a 1901 year start from a year 1 instant
  and produced `weeklyBudget:u:0001-W-99115`.
- **`weeklyBudgetKey` emitted `NaN-WNaN`**, because `new Date("1-06-01T00:00:00Z")` is an invalid
  date. Not merely a misnamed bucket: it is the *same* bucket for every week of every such year, so
  the weekly cap stopped being weekly and became a single quota that never reset.
- **The monthly cap silently stopped binding, in TypeScript only.** `monthlyBudgetKey` takes the
  first seven characters of the local day, which is the month on `2026-06-01` and the whole date on
  `1-06-01`, so every day got its own monthly bucket. Python's monthly key was correct throughout,
  which means the same policy bound in one sibling and not in the other. Found while reviewing the
  fixtures rather than by them, and the reason this carries unit tests as well: a gate that stops
  working is a bug, and a gate that quietly stops stopping is worse.
- **Python's `iso_week_key` emitted `1-W22`** where 5.1 fixes the format at `YYYY-Www`
  ([#37](https://github.com/Bubblegunn/proactive-gate/issues/37)), and **`local_clock` depended on
  whether the interpreter's `strftime("%Y")` pads**
  ([#38](https://github.com/Bubblegunn/proactive-gate/issues/38)). The day string is now built from
  the fields, so the answer no longer depends on which C library the build was linked against.

Until this release the two implementations disagreed on **all three** budget keys for the same
instant, measured against the published 0.7.0 packages rather than against the source:

| counter | TypeScript 0.7.0 | Python 0.7.0 |
|---|---|---|
| daily | `budget:u:1-06-01` | `budget:u:0001-06-01` |
| weekly | `weeklyBudget:u:NaN-WNaN` | `weeklyBudget:u:1-W22` |
| monthly | `monthlyBudget:u:1-06-01` | `monthlyBudget:u:0001-06` |

So one store serving both siblings kept two sets of counters for those dates rather than one wrong
set, and the parity the shared fixtures were supposed to guarantee held for decisions while failing
for the keys those decisions are recorded under. All three agree now. Both skip files are empty again
and the conformance table reads 57 of 57 in both languages.

The spec moves to **1.4.1**: fixtures only, no new vocabulary. It is tagged separately as
`spec/v1.4.1` once this is released, because `SPEC.md` requires the skip files to be empty at a
stable release and they were not until this change.

## 0.7.0 (2026-09-12)

**Three presets and a store, all from one contributor in a day.** [@LouisDeconinck](https://github.com/LouisDeconinck)
added Brazil's LGPD ([#30](https://github.com/Bubblegunn/proactive-gate/pull/30), closing #14), the
WhatsApp Business rules ([#31](https://github.com/Bubblegunn/proactive-gate/pull/31), closing #13)
and `AsyncSqliteStore` for the Python sibling ([#32](https://github.com/Bubblegunn/proactive-gate/pull/32),
closing #17).

`brLgpd` carries the consent model and nothing else, because the law has nothing else to carry:
article 8 paragraph 4 makes generic authorisations void, which is why it is a named
`consents.marketing` read at every send, and article 14 paragraph 1 requires a parent's or
guardian's specific consent, which `consents.parental` carries for a user marked minor. There is no
soft opt-in for an existing customer and no time-of-day rule anywhere in the statute; a fixture pins
the first and the note says the second.

`whatsappBusiness` holds the three rules a gate can hold: opt-in before any business-initiated
message, the 24-hour customer service window for free-form sends, and one message every six seconds
to the same user, which Meta states as 600 an hour. `{ template: true }` drops the window check,
because an approved template is the only thing allowed outside it. The note says what the preset
cannot carry, and which way its rate-limit approximation errs.

`AsyncSqliteStore` is the same file, schema and expiry rules as `SqliteStore` behind the async
protocol, over `aiosqlite` as an optional extra imported in the constructor, so importing the
package without it still works. Its expiry rules are checked against the synchronous store operation
by operation, and a concurrent task keeps getting turns while it writes, which is what "does not
block the loop" means. Both halves are pinned by tests in this release rather than by a measurement
nobody could repeat: a blocking driver would give a concurrent task exactly zero turns.

**Spec 1.4.0.** Two presets joined the vocabulary, so the fixture suite is 36 and the version is a
minor under the rule in `SPEC.md`: an implementation that does not know a preset name must reject
the policy, so nobody already passes a fixture that names one. Tag `spec/v1.4.0` after the release.

**One follow-up that was ours rather than a contributor's.** No suite in either language ever
asserted that the expired-row sweep runs on `set()`, only on `incr()`; mutation-testing #32 found
it, and three tests now cover the other write path in all three stores.

**A review of 0.6.0 found five ways the simulator could lie, and one published claim that was
false. All six are fixed, each with the behavioural test that reproduces it first.**

- **One clock.** `simulate()` built its store without the simulation's clock, so TTLs ran on wall
  time: a week of simulated traffic passes in milliseconds, so a one-hour deduplication window
  never reopened and a duplicate a real deployment would have allowed was reported as suppressed.
  The store now runs on the simulated instant. Budget rows are snapshotted at each commit instead
  of read back at the end, because the daily key carries a two-day TTL and a report written after a
  simulated week would otherwise show zeros for the first days.
- **State is read again, never remembered.** A deferred candidate was re-evaluated against the user
  snapshot it was deferred with, so consent withdrawn at 08:30 did not stop a 09:00 retry. The
  contract is now explicit: the snapshot used at any instant is the newest one at or before it, and
  a stream may carry a state change with no candidate attached, which is how a revocation is said.
- **Evaluation time and delivery time are different instants.** A future `deliverAt` was recorded
  and then ignored: the send was counted at the evaluation moment, so quiet hours and the daily
  volume were attributed to a moment when nobody was disturbed. The delivery now happens at that
  instant, is re-evaluated there, and is counted there. The budget unit stays on the day the gate
  spent it, which is what its key says.
- **Deferral terminates.** A `retryAt` that was missing, in the past or equal to now re-queued the
  same instant for ever; each of those three inputs ran until the process aborted. They are now
  recorded as broken deferrals. The expiry window is measured from a candidate's first sighting
  rather than from its latest hop, so a check that defers in three-hour steps can no longer carry a
  candidate past a four-hour expiry indefinitely, and an attempt cap sits behind both.
- **A difference is more than a different outcome.** Two policies that hold the same candidate for
  different reasons, or deliver it at different times, are differences of their own kind now. The
  aggressive-against-respectful comparison reports 80 differing candidates where 0.6.0 reported 73.
- **A candidate id is an identity**, and a duplicate is refused rather than silently collapsed into
  one row. A time zone change no longer re-judges earlier deliveries: every send records the local
  day and the quiet-hours verdict in force at the moment it landed.

**The correction that matters most.** 0.6.0 said "adding a check cannot make the gate louder" in the
changelog and in the documentation. It is false. With a daily budget of one, a delivery at 10:00 and
a candidate at 23:50 snoozed until 00:10, adding `snooze({ defer: true })` takes deliveries from one
to two, because a deferral crosses the local-day boundary into an untouched budget. The
counterexample is now a regression test, and the claim that survives is narrower: over the default
order, whose checks all reject rather than defer, no added check raised deliveries in 180 policy
pairs across three generated weeks. That is a measured result in that scope, not a theorem.

The demo figures are unchanged, and that is worth stating plainly: 171 candidates, 171 delivered
with no gate against 74 through the default order, 52 landing inside the recipient's own quiet hours
against 3. None of the six defects touched the default run, because the generated week has no
deferring policy, no deduplication key, no postponed delivery, no time zone change and no repeated
candidate id. They were real, and they were invisible in the figures the README quotes.

## 0.6.0 (2026-09-12)

**You can now see what the gate changes before you install it.** `npx proactive-gate simulate`
replays one week of an assistant that fires when its own data arrives, first with no gate at all and
then through the default order, and prints what each policy did with every candidate: sent, held and
why, deferred and until when, which budget unit it spent. No key, no account, nothing to configure.
Over the generated week the ungated stream delivers all 171 candidates, 52 of them inside the
recipient's own quiet hours; the default order delivers 74, and the only three that reach a quiet
window are critical, which is what the documented priority floor is for. The quiet-hours figure is
measured against the window each person set rather than against a fixed curfew, so the user who
asked for no quiet hours is not counted as harmed by her own preference.

Point it at your own candidates for a number about your own traffic, `simulate your-events.jsonl`,
which runs locally with an in-memory store per policy. `--policy a.json --policy b.json` compares
two real policies, which is the run to do before changing one in production. `--why` prints the
sentence `explain()` already produces under each held candidate, `--disagreements` prints only the
candidates the policies disagreed about, and `--json` prints the whole result.

It adds no check, no store, no adapter and no dependency, and the decision path is untouched: the
same gate runs twice and the difference is rendered. The generated week is a seeded generator with
its parameters written down rather than a committed blob, dumped to `examples/week.jsonl` for
reading and deliberately not packed.

**Adding a check cannot make the gate louder, measured rather than asserted.** `test/monotonicity.test.ts`
compares 180 policy pairs over three generated weeks, each pair differing by exactly one check, and
no added check raised the number of deliveries. It includes the two cases a budget makes suspicious:
quiet hours in front of a cap, where a night hold leaves a unit unspent for the morning, and a
deferring snooze in front of a cap, where a deferral can carry a candidate into the next local day's
counter. A measured result over those weeks, not a theorem; a counterexample fails the test.

**The feature surface is frozen, and the boundary is now written down.** The twelve checks are the
policy surface, the preset catalogue is frozen at what is merged, and adapters and stores are frozen
on the same terms: the next one arrives with the person who needs it. A new preset needs somebody
shipping to that channel or under that instrument who says so on the issue, because every country
has a law and a preset nobody ships against rots unread. `ROADMAP.md` keeps one invitation, an
implementation of `spec/` by somebody who is not us, and `spec/CONFORMANCE.md` now has the section
that makes it actionable. Nothing about the published API changed.

`bench/compare-policies.mjs` and its test are removed: the command answers the same question inside
the product instead of in a bench folder only the maintainer runs, and its two policies live on as
`examples/policies/aggressive.json` and `examples/policies/respectful.json`.

## 0.5.0 (2026-09-12)

**India, as the regulation actually reads.** `inTcccp` encodes TRAI's Telecom Commercial
Communications Customer Preference Regulations, 2018. The widely repeated "9am to 9pm" appears
nowhere in the primary text: Schedule-II item 3 defines nine time bands a subscriber registers
preferences against, and its Note-1 keeps four of them, 00:00-06:00, 06:00-08:00, 08:00-10:00 and
21:00-24:00, off for every customer until that subscriber switches the band on. The preset carries
that as one opt-in consent per default-off band rather than one hard window, which would deny the
opt-ins the regulation expressly allows, alongside the promotional consent regulation 9 requires.
The default state is therefore 10:00 to 21:00 in the recipient's own zone.

Contributed by [@LouisDeconinck](https://github.com/LouisDeconinck) in
[#29](https://github.com/Bubblegunn/proactive-gate/pull/29), closing
[#15](https://github.com/Bubblegunn/proactive-gate/issues/15), in TypeScript and Python together
with a spec fixture.

**Checked against the gazette rather than a summary.** The reading was verified in TRAI's May 2026
consolidated text, which the pull request cited, and then in the 2018 gazetted regulation, where
Schedule-II Note-1 appears word for word. The consolidation says on its own first page that the
gazetted document prevails where they differ, so the gazette is now cited too. Every band edge was
run rather than reasoned about: 09:59 held, 10:00 allowed, 20:59 allowed, 21:00 held, 23:59 held,
and opting into one band does not open another, in the TypeScript, the Python and the JSON-policy
paths alike.

**His preset found a defect in the last release.** `requiresConsent` with a window returned a bare
pass when the local time was outside it, which is the same trace entry as "the consent is on file",
so `explain()` said *The "band00to06" consent the check needs was in place* about a consent the user
had never given. Running four windowed consents at once made three of five lines false at any hour.
The check now says why it passed, and the sentence follows it: *The "band00to06" consent is only
needed between 00:00 and 06:00, and it was outside those hours.* A fixture cannot express a reason
on a pass entry, so both suites and the cross-language parity run carry this one.

**The spec is 1.3.0, not 1.2.1.** A patch adds fixtures existing implementations already pass, and
7.3 requires an implementation to reject a policy naming a preset it does not know, so no
implementation at 1.2.0 can pass a fixture whose policy names `inTcccp`. The rule had no case for
presets, this was the first change that is only a preset, and `SPEC.md` and `CONFORMANCE.md` now
state it. The `spec/v1.3.0` tag follows this release.

**What the legal presets do not cover, measured.** With no `user.timezone` there is no local time to
compare, so `usTcpa` skips its whole window, `krNetworkAct50` skips its night consent and `inTcccp`
skips all four bands: a solicitation at 02:00 local goes out in each case, and nothing said so
anywhere until now. `kakaoBrandMessage` and `cnMinorMode` are unaffected, their windows being in a
fixed zone. `inTcccp` also states the scope the regulation itself draws: the preference machinery is
about promotional communication, and TRAI's own block options exempt transactional and service
communication and government communication.

## 0.4.1 (2026-09-12)

**`proactive_gate.__version__` said 0.2.0.** It had said that since 0.2.0, through four
releases, while the wheel's own metadata was right each time. Nothing compared the two, so
nothing noticed. It was found by installing the published 0.4.0 wheel and asking it what
version it was.

The value is now correct, and two things keep it that way rather than none: `release-gate.mjs`
compares every `python/src/<package>/__init__.py` against `package.json` on each push, the way
it already compares `CITATION.cff` and `pyproject.toml`, and `scripts/release.mjs` writes it
during a release so the next version cannot drift either. A Python test asserts the same thing
against `pyproject.toml`, because somebody working only in Python runs pytest and not the gate.

Verified non-vacuous: setting the value back by one patch makes the gate name the file and
exit 1.

Nothing else changed, and the TypeScript package is unaffected; it states its version once.

## 0.4.0 (2026-09-12)

**A rejection reason a product manager can read.** `explain(decision)` renders a decision as
sentences built from the same trace with nothing added: "Held until 08:00 because the user's
quiet hours run 22:00 to 08:00 Europe/Istanbul and normal priority is below the critical floor
needed to override them", beside the machine reason, which is unchanged. The allowed path
renders too, because "why did this go out at 22:30" is asked more often than the reverse.

Contributed by [@LouisDeconinck](https://github.com/LouisDeconinck) in
[#28](https://github.com/Bubblegunn/proactive-gate/pull/28), closing
[#23](https://github.com/Bubblegunn/proactive-gate/issues/23), in TypeScript and Python together.

Every check this package ships has a sentence, including the awkward ones the issue was really
about: a budget near its limit says the unit is spent when the message actually goes out, and a
cooldown after dismissals names the count, the window and the instant the silence ends. A reason
matching no template is quoted verbatim and attributed to the check that said it. The renderer
reads no clock and inspects neither candidate nor user, so it cannot describe a decision the gate
did not make. `language` is a parameter and an unknown code fails loudly rather than quietly
answering in English.

**What the review measured.** The two catalogs render identically: 303 sentences across 89
decisions in all 32 fixtures, the same in both implementations byte for byte, and the same again
under a foreign time zone and a Turkish locale. `scripts/explain-parity.mjs` now runs that
comparison in CI on every push, because two catalogs maintained by hand in two languages drift
while both suites stay green, each asserting only its own wording.

Instrumenting the catalogs showed 59 of 67 templates rendered by the TypeScript suite and 56 of
67 by the Python one. All eight unrendered sentences turned out to be correct when they were
exercised by hand, which is the good version of that finding and not a reason to leave them
unread. Both suites now render 67 of 67, and the sweep fails when a check this package ships
falls back to quoting its machine reason instead of having a sentence.

**Two sentences changed after the merge.** A rate limit said "per 1 hour" and "per 1 day", which
is exactly what `kakaoBrandMessage` and `lineMessagingApi` ship; it now says "per hour" and "per
day", the way the dedupe window next door already said "within the last day". And the presets'
own window ids (`window:tcpa`, `window:kakao`, `window:minor`) were not among the id conventions
the renderer knew, so on the way through, the check a whole policy exists to satisfy read as a
quoted fallback. The window now gets its sentence and its name: *The "tcpa" allowed window did
not block it.* Over the fixture corpus that took quoted fallbacks from six to two, and both
survivors are correct: they are the cn-minor-mode wrapper saying "not a minor", which is the
wrapper's own reason and not a window at all.

## 0.3.1 (2026-09-12)

**A key nobody reads again used to live in the table forever.** `SqliteStore` pruned an expired row
only when a read touched it, and the keys this gate writes most are dated: `budgetKey`,
`weeklyBudgetKey` and `monthlyBudgetKey` all carry the day, so nobody ever reads yesterday's key and
nothing ever deleted it. Measured before the fix, 200 keys with a TTL that are never read again left
all 200 rows in place, which over a year of daily budgets is a year of dead rows.

Contributed by [@LouisDeconinck](https://github.com/LouisDeconinck) in
[#27](https://github.com/Bubblegunn/proactive-gate/pull/27), closing #26, in TypeScript and Python
together.

`set` and `incr` now delete every already-expired row before writing, and a partial index on
`expires_at WHERE expires_at IS NOT NULL` keeps that delete proportional to the dead rows instead of
a table scan. Deleting everything expired rather than a slice of it is what removes the question the
issue could not answer: there is no retention horizon to choose and defend, because the only boundary
is the expiry each row already carries.

**What it costs, measured rather than asserted.** 5,000 `incr` calls over 50 rotating keys against an
in-memory database: 10.2 microseconds each before, 10.3 after, when nothing is expired; 9.6 before
and 9.9 after when rows are expiring constantly. About one percent on the path the gate actually runs.

Verified non-vacuous before merge: with the four sweep calls removed and everything else left in
place, exactly one TypeScript test and one Python test fail, both of them his, and nothing else in
either suite.

`SqliteStore.size()` is new and additive, marked a test helper the way `MemoryStore.size()` already
was, so a test can count rows rather than read dead keys back. Nothing a `get` can observe has
changed, because an expired row was already invisible to it.

`PostgresStore` is not in this release. The same delete and the same partial index apply to it
verbatim, and [#25](https://github.com/Bubblegunn/proactive-gate/pull/25) is where that lands.

## 0.3.0 (2026-09-06)

**Anyone writing a `Store` can now prove it behaves.** `proactive-gate/store-contract` exports
`storeContract`, the same suite `MemoryStore` and `SqliteStore` are held to: `get`, `set` and `del`,
`incr` from an absent key, concurrent `incr` atomicity, the expiry boundary, matching TTL behaviour
for `set` and `incr`, and a seeded random operation sequence replayed against `MemoryStore`. Until
now that suite existed only inside our own tests, so a Postgres, DynamoDB or KV store had no way to
find out it disagreed with us about when a key dies.

Contributed by [@Aaqibhafeezkhan](https://github.com/Aaqibhafeezkhan) in
[#24](https://github.com/Bubblegunn/proactive-gate/pull/24), closing #11.

Two decisions in it are worth knowing about. A store whose backend owns the clock, which is every
store backed by a server, declares `expiry: "skip"`, and the expiry cases are then **reported as
skipped** rather than silently omitted; a suite that quietly tests less is worse than one that
refuses. And a factory can return a `teardown`, run in a `finally`, so a store holding a connection
is closed even when a test throws.

It lives on its own subpath rather than the package root, so importing `proactive-gate` still
reaches no Node built-in. That matters for the adapters: `node:test` does not exist in the edge
runtimes the Vercel AI SDK is commonly deployed to.

Verified non-vacuous before merge against three stores each broken one way, a non-atomic `incr`, an
expiry firing one millisecond late, and an `incr` that drops its TTL. Each is caught, by the test
you would expect to catch it.

`test/properties.test.ts` now calls the exported suite instead of keeping a private copy, so the
two cannot drift apart.

## 0.2.5 (2026-09-05)

Documentation only; no behaviour changed.

**The README said quiet hours are a single window, the same on every day of the week. That stopped
being true when the per-day schedule landed, and the feature was never documented anywhere.** A
reader following the README would have written their own check for a Friday or a Shabbat window
that the package already supports. Both READMEs now describe it.

The ISO-week limit is stated with the measurement behind it instead of asserted. Of the twenty most
populous countries, CLDR gives Monday to seven, Sunday to eleven and Saturday to two, which anyone
can read with `new Intl.Locale("und-EG").getWeekInfo().firstDay`. The key stays ISO for two reasons
now written down: a counter already in a store is keyed by it, so moving the key silently resets
every user mid-week, and the day a counter turns over is not the day a user is protected on, since
quiet hours already read the user's own weekday.

The Python package no longer describes itself as unverifiable. Three files still said it was
uploaded by hand with a token and carried no build provenance, and that trusted publishing was not
configured. That stopped being true at 0.2.2. PyPI's integrity endpoint returns a publish
attestation for both 0.2.4 files naming `Bubblegunn/proactive-gate` and `release.yml`. Releases
before 0.2.2 still carry none, and the text says so.

Every release is now archived on Zenodo. `CITATION.cff` carries the concept DOI
`10.5281/zenodo.22393512` in the top-level `doi` key, which is the field GitHub's citation button
renders into BibTeX, and both READMEs gained a Cite section.

The README changes above were committed in `c79d4e0`, whose message describes only the Python
change: two agents were editing this repository at once and one `git add -A` swept the other's
work. Noted here because the history cannot say it.

## 0.2.4 (2026-09-05)

The conformance suite is an artifact rather than a folder in this package. `spec/` now ships in the
npm tarball, so `node_modules/proactive-gate/spec/fixtures` exists after an install, and it is
addressed by its own `spec/vX.Y.Z` tag series so an implementation in any language can pin it
without depending on npm or PyPI.

`spec/CONFORMANCE.md` states what passing means field by field, how to declare a skip, and how to
say which spec version an implementation targets. Silence about a failing fixture is the one thing
that makes a conformance claim worthless, so the honest form of a partial claim now has a place to
be written down.

The README carries a conformance table generated by `npm run conformance-table` and checked in CI,
covering both implementations against the fixtures. It reports no runtime version, because that
differs per machine and would leave the committed table permanently stale. A non-conforming fixture
exits non-zero rather than producing a row that says "failed".

Two sections of prose, both resting on specifications read at the source: what made the JSON Schema
Test Suite work and why the same conditions do not hold here, and where this sits next to MCP
elicitation and A2A push notifications, neither of which answers whether a message should be sent
now.

No check, policy, default or fixture behaviour changed. A policy written before this release
behaves identically after it.

## 0.2.3 (2026-09-05)

`dedupe`: one delivery per event per window, for transports that deliver at least once. A webhook resent because it did not get its `200` quickly enough, or the same event handed to two workers, produced two messages; `dedupe` claims `candidate.dedupeKey` atomically at commit with the increment the budgets use, so both attempts pass the check and exactly one commit wins. Off unless asked for, with `defaultChecks({ dedupe: true })` or a policy entry. Without a `dedupeKey` it skips rather than guessing an identity, because a deduplication keyed on something unique per attempt silently does nothing.

It consumes before the budgets, so a suppressed duplicate does not spend one of the user's messages for the day. The cost of that ordering is stated rather than hidden: an event that clears `dedupe` and is then refused by an exhausted budget has claimed its key for the rest of the window. The window is fixed from the first claim, not sliding.

The 24-hour default is the common retry horizon rather than a number of ours: Stripe prunes an idempotency key after 24 hours, and Nylas gives the same figure as the safe default for webhook deduplication. Both are linked from the README.

Spec 1.2.0 adds clauses 5.5 to 5.8 and two shared fixtures, so the Python package is held to the same behaviour rather than trusted; the race is a language-side test because a fixture cannot express concurrency. Verified by mutation: a read-then-write claim fails the race test in TypeScript and the fixtures in Python.

`dist/test/dedupe.test.js` was missing from the test script when it was written, so the seven new tests would not have run in CI. Added.

The Python gate now selects commit-time consumers by the presence of `consume_plan` rather than by a list of classes, matching the TypeScript side, so a new consumer is honoured without being registered in two places.

## 0.2.2 (2026-09-05)

Quiet hours can differ by day. A single window applies every day, which cannot express a working week that is not Monday to Friday: a Friday and Saturday weekend, a Friday evening to Saturday evening silence, and a public holiday all had to be written as a custom check. `quietHours` now takes a schedule as well as a window, resolving a date before a weekday before a default, where `null` at any level means the day has no quiet hours. A window still belongs to the day it opens on, so one that crosses midnight silences the next morning and the reason names the day it came from. The single-window form is unchanged and is still the default; a schedule whose every day resolves to the same window behaves identically to that window, asserted minute by minute in a zone with a 45-minute offset. Spec 1.1.0 adds clauses 6.4 to 6.7 and three fixtures, so the Python sibling is held to the same behaviour; breaking the carry in either implementation fails them.

There is no bundled holiday calendar and there will not be one: a caller supplies the dates it observes, because a bundled calendar goes stale without anyone noticing. What a schedule still cannot express is a window longer than 24 hours in one row; Friday evening to Saturday evening is two rows, and the README says so.

`publish-pypi` is skipped until the repository variable `PYPI_TRUSTED_PUBLISHER` is `true`. No trusted publisher exists on PyPI for this project, so the OIDC exchange returned `invalid-publisher` and every tagged release went red for a credential that cannot be created from CI. The job is gated rather than ignored: `build-python` still runs mypy strict, the tests, `python -m build` and `twine check` on every release, and the run prints what to configure at pypi.org and the `gh variable set` that turns publishing on. 0.2.1 is on PyPI, uploaded from a local build with a one-off token, since a trusted publisher cannot be configured for a project that does not exist. That release carries no build provenance and the Python documentation says so; the npm package's provenance is unaffected. CONTRIBUTING lists the three steps that move publishing into the workflow, in the order that keeps publishing possible throughout.

## 0.2.1 (2026-09-05)

The utility floor's threshold was attributed to "PRISM". No system of that name appears in Horvitz, Jacobs and Hovel, "Attention-Sensitive Alerting", UAI 1999, nor on Horvitz's publication index; the system in that paper is named Priorities. Corrected in the source, both READMEs, the documentation site and the generated API page. The mathematics is unchanged and is now stated directly: alerting costs `(1 - p) * cFA`, silence costs `p * cFN`, so the threshold is the classical Bayes decision boundary.

Every default now says whether it was measured or chosen. One was measured: `lambda = 1/43` comes from the field study in Achlioptas and Horvitz, "Principles of Bounded Deferral", 113 employees over three business days between 10am and 4pm, 4,803 busy situations, mean 43.12 s with a standard deviation of 51.79 s. The same paper's two-subject analysis gives 11 s for one person and 101 s for the other, so the spread between two people exceeds the default. `staleness` and `boundSeconds` are labelled as scale choices, since only their ratio reaches `t*`. The seven-day trust ramp and the three-in-thirty cooldown are labelled as ours, with no study behind them. The daily budget of five is ours in a direction Pielot and Rello support, citing a median of 63.5 notifications a day.

Two citations added: Okoshi, Tsubouchi and Tokuda (*Pervasive and Mobile Computing* 50:1-24, 2018), a Yahoo! JAPAN deployment of more than 680,000 users where deferring to an interruptible moment cut response time by 49.7 percent, as evidence for the direction only; and Pielot and Rello (MobileHCI 2017) as the counterweight, where a day without notifications left 15 of 30 participants afraid of missing something urgent and three approached recruits declining outright because their workplace expected them to be reachable. A gate that suppresses is not free and the README says so.

Two design limits documented and pinned by tests: the weekly budget uses the ISO week, so it refills on Monday, one day into a Sunday-to-Thursday working week; and quiet hours are a single window applied to every day, so a Friday, Shabbat or holiday rule cannot be expressed without a custom check.

No new preset. Canada's CASL and Australia's Spam Act carry no time-of-day rule; the Brazilian window comes from a bill, not a law, and covers telemarketing calls; and India's regulation makes time bands a preference the subscriber registers rather than a fixed statutory window, with secondary sources disagreeing about whether it starts at 09:00 or 10:00. The README now says that a regulatory preset binds a message only when the message is itself commercial.

## 0.2.0 (2026-09-05)

The optional checks now name their sources and their limits: the package ships no model, no cost and no probability, the rules come from Horvitz's attention-sensitive alerting and bounded deferral, and the field figure cited is Iqbal and Horvitz (CHI 2007), roughly 11 to 16 minutes to return to a suspended task. The widely repeated "23 minutes 15 seconds" is not from a peer-reviewed paper and is not used.

Property tests over the check order and the store contract, generated from a seeded PRNG rather than written case by case: the trace is always a prefix of the declared order with every check reporting once, a non-rejecting check cannot stop a decision however it misbehaves, racing deliveries commit exactly `min(racers, limit)` units, a replayed decision spends one, and `MemoryStore` and `SqliteStore` answer the same random operation sequence identically. Verified against a mutant: rewriting `consume` as read-then-write fails the race property.

`proactive-gate init` writes a readable policy with the ten default checks, appends a named preset before the budget, and prints that preset's sources next to the lines that wire the gate into AI SDK, Mastra, LangChain, OpenAI Agents or none of them. `--list` names the fourteen presets and the four frameworks, and the command refuses to overwrite an existing policy without `--force`. A test compiles the policy every preset produces.

`npm run bench:compare` replays a committed day of 21 candidates for 7 users through an honest hand-rolled policy of five `if` statements and through a gate built from the same fixture, and prints the six disagreements with the reason for each. `test/naive.test.mjs` pins the three shortcuts that policy takes: a fixed UTC offset sends half an hour into quiet hours the day New York leaves daylight time, a UTC-day budget key silences a Tokyo user for nine hours and pays a Los Angeles user twice, and a read-then-write counter lets two deliveries in flight both take the last slot while the counter still reads its limit afterwards.

- A behaviour contract in `spec/`: numbered requirements, fixture and policy JSON Schemas, 27 fixtures any language can run, `spec-lint` in CI, and `replay --fixtures`.
- Policy as data: `createGate({ policy })`, `compilePolicy`, `--policy policy.json`, `examples/policy.json`.
- Outcome model: `defer` with `retryAt`, shadow mode, `nearLimit` notes on budgets, `hooks` (before, after, error, finally), a decision `id` and an idempotent `commit`.
- Optional checks `utilityFloor` and `boundedDeferral`, fed by the caller's own model.
- One command releases a version: `npm run release -- X.Y.Z` dates the CHANGELOG entry, sets the version in `package.json`, `CITATION.cff` and `python/pyproject.toml`, tags, pushes, and moves the `v0` major tag. The release workflow starts on full version tags only, so the moving tag cannot start a second publish.
- Fourteen presets with sources under `proactive-gate/presets`, built from `allowedWindow`, `requiresConsent`, `monthlyBudget`, `rateLimit`, `recentInteraction` and `windowBudget`.
- Adapters on subpaths for the Vercel AI SDK, Mastra, LangChain and OpenAI Agents, and a Claude Code `PreToolUse` hook (`proactive-gate hook`).
- A Python sibling in `python/` (sync and async gates, Memory, SQLite and Redis stores) that passes the same fixtures.
- Docs site with a browser playground at https://bubblegunn.github.io/proactive-gate/.
- Runnable adapter examples that need neither the framework nor a network: `examples/mastra/` and `examples/ai-sdk/`, each with a JSON policy and a day of candidates, run by `npm run examples` and pinned by tests.

## 0.1.2 (2026-09-05)

- `SqliteStore` on `node:sqlite` (Node 22.5+), persistence for single-instance deployments, by @Aaqibhafeezkhan (#3).
- `weeklyBudget` check keyed on the user's local ISO week, consumed atomically at commit next to the daily one, `defaultChecks({ weeklyLimit })`, by @edwardsong08 (#9, closes #2).

A LangGraph example, a comparison with hand-rolled checks and feature flags, a benchmark (`npm run bench`) with the measured line in the README, and a generated API reference under `docs/api`.

## 0.1.1 (2026-09-05)

Mastra example, a real decision trace in the README, a "Writing your own check" section with a test, Turkish README, contributing guide, issue templates, roadmap, and a provenance release workflow.

## 0.1.0 (2026-09-05)

First release: createGate, twelve checks in the LILA order, MemoryStore and RedisStore, commit-time atomic budget, fail-open or fail-closed on store errors, record/inspect, and the `replay` CLI.
