# proactive-gate behaviour contract

Version: see `SPEC_VERSION`. The key words MUST, MUST NOT, SHOULD and MAY are to be read as in
RFC 2119. An implementation conforms when it passes every fixture under `fixtures/` for its
declared spec version, minus the fixtures listed in its `skip/<impl>.txt` file, which MUST be
empty at a stable release.

Versioning: patch releases add fixtures that existing implementations already pass; minor
releases add a check or field and mark it with `since`; major releases change an expectation.
A preset added to the vocabulary is a minor, because 7.3 requires an implementation to reject a
policy naming a preset it does not know, so a fixture that names the new preset is one no existing
implementation can pass.
An implementation declares the spec version it targets, and its CI MUST assert that the value
equals `SPEC_VERSION`.

## 1. Inputs

1.1 An evaluation input is a user, a candidate and an instant `now`. `now` MUST be supplied by
the caller in fixtures and MAY default to the current instant in library use.

1.2 A user has at least `id` and `consent`. Optional fields: `proactiveEnabled`, `mode`,
`snoozedUntil`, `mutedTypes`, `intensity` (low, normal, high), `timezone` (IANA), `quietHours`
(a window, or a schedule; see 6.3), `createdAt`, `surfaces`, `consents` (map of
name to boolean), `lastInboundAt`, `minor`, `existingCustomer`.

1.3 A candidate has at least `id` and `type`. Optional: `priority` (low, normal, high,
critical; default normal), `surfaces`, `channel`, `busy`, `pAccept`, `pNeed`, `payload`.

1.4 An implementation MUST NOT read `payload`.

## 2. Evaluation order and short circuit

2.1 An implementation MUST run checks in policy order and MUST stop at the first check whose
outcome is `reject` or `defer` and which is not in shadow mode.

2.2 The trace MUST list every check that ran, in order, with its outcome kind. Checks after the
stopping check MUST NOT appear.

2.3 The surfaces of an allowed decision start as the candidate's surfaces (default `["feed"]`)
filtered by the user's allowed surfaces when the user lists any, and MAY be narrowed by
`adjust` outcomes.

## 3. Outcomes

3.1 A check returns exactly one of `pass`, `reject` (with a reason), `adjust` (reason, optional
`deliverAt`, optional `surfaces`), `skip` (reason), or `defer` (reason and `retryAt`).

3.2 A check marked non-rejecting that returns `reject` MUST be recorded as `skip` and MUST NOT
stop evaluation.

3.3 `defer` produces a decision with `allowed` false, `deferredBy` set to the check id and
`retryAt` set to the instant the check supplied. `rejectedBy` MUST be absent.

3.4 A `pass` MAY carry `nearLimit` with `used` and `limit`; the decision lists every such entry
in order.

3.5 A check that throws MUST be recorded as `skip` and evaluation continues when the gate fails
open, or as `reject` and evaluation stops when it fails closed. The default is open.

3.6 A decision that is not allowed MAY carry `nextAllowedAt` (since 1.5.0): the earliest instant at
which the check that stopped evaluation would stop refusing the same candidate for the same user,
computed from the inputs and `now` alone. It is a lower bound and not a promise: a check later in
the order can still refuse at that instant, so the caller evaluates again then. It MUST come from the
check that stopped evaluation and never from a check in shadow mode. It MUST be absent when the
decision is allowed, when that check cannot name an instant, and when the instant is not after `now`.
A deferred decision (3.3) carries its `retryAt` as `nextAllowedAt`.

3.7 The checks that name an instant, and what it is. `snooze`: the user's `snoozedUntil`.
`quietHours`: the earliest minute after `now` at which no quiet window applies by the user's local
clock, resolved with 6.4 and 6.5, so a window that ends where the next one begins does not open the
gate. A window end that falls in a local time that does not exist (the hour a spring-forward change
skips) resolves to the first minute after the gap. One that falls in a repeated hour resolves to the
first minute at which the check would pass, even if a later minute of the same hour is quiet again.
`dailyBudget`, `weeklyBudget`, `monthlyBudget`: the earliest minute after `now` at which the budget's
store key (5.1) differs, which is the start of the user's next local day, ISO week or month, or of the
next UTC day, week or month for a user with no zone. Every instant except the snooze's own is a whole
minute. The checks listed here MUST name the instants defined here. A check not listed here MAY leave
`nextAllowedAt` absent. The TypeScript implementation additionally names the next opening of
`allowedWindow` and the end of a windowed `requiresConsent`; both are lower bounds in the sense of 3.6,
and other implementations MAY omit them.

## 4. Shadow mode

4.1 A check with `shadow` true that returns `reject` or `defer` MUST be recorded in the trace
with its real outcome kind and `shadow` true, its id MUST be appended to `shadowed`, and
evaluation MUST continue as if it had passed.

## 5. Store keys and atomic commit

5.1 Keys, before the implementation's prefix (default `pg:`):
`budget:<userId>:<YYYY-MM-DD>` local day, `weeklyBudget:<userId>:<YYYY>-W<WW>` ISO week of the
local day, `monthlyBudget:<userId>:<YYYY-MM>`, `cooldown:<userId>:<type>` (JSON array of epoch
milliseconds), `rate:<scope>:<window>` for rate limits, `windowBudget:<userId>:<epochSeconds of
lastInboundAt>`, `commit:<decisionId>`.

5.2 Budget checks read the counter at evaluate and MUST NOT increment it. `commit` MUST
increment atomically, in check order, and return false when a counter exceeds its limit.

5.3 `commit` MUST be idempotent on the decision id: a second call returns the first result
without incrementing. The decision id is unique per evaluation, not per candidate, so two workers
that share a store never share one.

5.4 `commit` on a decision that is not allowed MUST return false without touching the store.

5.5 `dedupe` keys as `dedupe:<userId>:<candidate.dedupeKey>`. With no `dedupeKey` on the
candidate it MUST skip, not pass silently: a deduplication keyed on something unique per
attempt does nothing, and an implementation that guessed a key would hide that.

5.6 `dedupe` MUST NOT claim at evaluate. It reads the key at evaluate and rejects when the key
is present; it claims at commit with the same atomic increment the budgets use, and only the
caller receiving the first increment may deliver. Two callers evaluating the same event
concurrently therefore both pass the check and exactly one commit succeeds. A read-then-write
claim is non-conforming.

5.7 Where `dedupe` and a budget are both present, `dedupe` MUST consume first, so a suppressed
duplicate does not spend a budget unit. The consequence, which implementations MUST NOT hide:
an event that clears `dedupe` and is then refused by an exhausted budget has claimed its key
for the remainder of the window.

5.8 The deduplication window is fixed from the first claim, not sliding. Incrementing an
existing key MUST NOT extend its expiry.

5.9 `incrBy(key, delta, ttlSeconds)` is an optional store method with INCRBY semantics: it adds a signed delta
atomically and returns the new value. The TTL applies only when the call creates the key, as for `incr`. A store
without `incrBy` is still conforming. The gate then cannot release a commit (10.1).

## 6. Clock and time zones

6.1 `now` is an instant. Local day, minutes and ISO week are derived from `now` in the user's
IANA zone; without a zone, UTC.

6.2 A check MUST NOT read a wall clock. Fixtures with `now` far in the future only pass when
`now` is honoured.

6.3 Quiet hours use `[start, end)` and may cross midnight; `start == end` is an empty window.

6.4 `quietHours` is either a window (`start`, `end` as `HH:MM`) or a schedule (since 1.1.0) with
optional `default` (a window or null), `days` (a map of `sun` to `sat` to a window or null) and
`dates` (a map of `YYYY-MM-DD` in the user's zone to a window or null). A window applies on every
day; a schedule resolves one window per local date, and an implementation MUST resolve it as
`dates[date]`, else `days[weekday(date)]`, else `default`, else none, where a present key whose
value is null means the day has no quiet hours.

6.5 A window belongs to the day it opens on. An implementation MUST treat a local time as quiet
when the window resolved for that local date contains it, or when the window resolved for the
previous local date crosses midnight and the time is before its `end`. The day resolved for the
current date takes precedence when both apply. A schedule whose every day resolves to the same
window MUST behave identically to that window given directly.

6.6 The weekday of a local date MUST be derived from the local calendar date, not from an
instant, so that a zone with an offset that is not a whole hour and a daylight-saving transition
cannot change it.

6.7 An implementation MUST NOT ship a calendar of holidays. `dates` is supplied by the caller.

## 7. Policy document

7.1 A policy is JSON with `specVersion`, optional `onStoreError`, optional `keyPrefix` and an
ordered `checks` array. An entry is `{ "id": <check>, ...options, "shadow"?: bool }` or
`{ "preset": <name>, ...options, "shadow"?: bool }`.

7.2 A preset entry expands in place to the preset's ordered checks.

7.3 An unknown check id or preset name MUST be rejected when the policy is compiled, naming the
known ids.

## 8. Trace

8.1 Each trace entry has `id`, `outcome`, optional `reason`, `ms`, optional `shadow`. `ms` is
informative and MUST NOT appear in fixtures.

## 9. Additions in 1.6.0

9.1 Data (S1). `UserState` gains the optional fields `deviceTimezone` (an IANA zone the device reports),
`consentUnknown` (true when the caller's consent lookup failed), `crisisUntil` (an instant, or null),
`hourStats` (a map from "0" to "23" to `{acted, dismissed}` counts, keyed by local hour), `tier` (a string)
and `dailyLimit` (a number, the explicit per-user override read by 9.12). `Candidate` gains `requested` (boolean), `kind`
("commitment" or "support"), `transactional` (boolean), `freshUntil` (an instant), `createdAt` (an instant)
and `evidence` (an object with `dataPoints`, `confidence` and `newSinceLast`). An evaluation input gains
`flags`, a map from name to boolean, which every check sees. Absent fields keep the behaviour of 1.5.0.

9.1.1 Instants (R4). An instant is an ISO 8601 date-time. With an offset or `Z` it is that instant. With no offset it is
UTC, whatever the zone of the host reading it, so "2026-09-04T12:00:00" is 12:00 UTC. A date alone ("2026-09-04") is
00:00 UTC. An epoch in milliseconds (a number) and a Date object are also instants. This applies to every instant field
named in this document. A JSON null in an optional instant field (`freshUntil`, `createdAt`, `snoozedUntil`,
`crisisUntil`) means the same as the field being absent (R1).

9.2 Effective zone (S2). The effective zone of a user is `deviceTimezone` when it is a valid IANA name, else
`timezone` when it is one, else none. It is the zone for quiet hours (6.4, 6.5), for `allowedWindow` with
`timezone` "user", for `requiresConsent` windows, for the day, week and month keys of the budgets (5.1) and
for the instants named in 3.7. A `deviceTimezone` that is not a valid zone is ignored, as if absent.

9.2.1 `quietHours` takes `onMissingTimezone`, either "skip" (the default, as in 1.5.0: a user with quiet hours
and no zone is skipped) or "reject". Under "reject", a user with no effective zone is rejected with a reason that
names the time zone, whether or not the user has quiet hours: the check rejects before it looks at quiet hours, so
a user without quiet hours and without a zone is rejected too. A user with a valid `deviceTimezone` is not rejected
for want of a zone, with or without quiet hours. Under "reject", the placeholder zone "UTC" is no zone unless a valid
`deviceTimezone` is present. Any other value of `onMissingTimezone` is a policy error: an implementation MUST refuse
to compile it, and MUST NOT treat it as "skip".

9.3 Consent fail mode (S3). `consent` takes `failMode`, a map from surface to "open" or "closed", with an
optional key `default`. When `consentUnknown` is true, each surface still on the table is kept if its mode is
"open": its own entry, else `default`, else "closed". The other surfaces are dropped by an `adjust` outcome that
lists the surfaces kept. When no surface remains, the candidate is rejected with a reason containing "consent
could not be determined". When `consentUnknown` is not true, `failMode` has no effect and the check behaves as
in 1.5.0. When `consentUnknown` is true, `consent` is unknown whatever the `consent` field says: a user with
`consent` true and `consentUnknown` true is decided by `failMode` exactly as a user with `consent` false would be.

9.4 Commitments (S4). A candidate with `kind` "commitment" is something the person set up, such as a reminder
they asked for. It bypasses `trustRamp`, `dismissalCooldown`, `mute` and every budget check (`dailyBudget`,
`weeklyBudget`, `monthlyBudget`, `windowBudget`, `rateLimit`): each passes it, and `consume` spends nothing for it.
Consent, the kill switch, snooze, quiet hours, dedupe and freshness still apply. A candidate of any other kind,
including "support", is not exempt.

9.5 Requested (S5). `trustRamp` passes a candidate whose `requested` is true, at any priority, with a reason
containing "requested". The ramp counts from `user.createdAt`, as in 1.5.0, and a requested candidate passes even
when `createdAt` is absent. Requested does not bypass consent or any other check.

9.6 Dismissal cooldown exemptions (S6). `dismissalCooldown` takes `exemptTypes`, a list of candidate types. A
candidate whose `type` is listed passes, with a reason that says it is exempt, whatever its dismissal count. A type
that is not listed is silenced as in 1.5.0. Commitments are exempt by 9.4 whatever their type.

9.7 Not-promotional exemption (S7). `requiresConsent` takes `exemptTransactional`, a boolean, default false (the
name is kept for compatibility). Marketing consent applies to promotion only. When the option is true, a candidate
is exempt, and passes with a reason containing "not promotional", without the named consent, when any of these holds:
`transactional` is true (the reason says "transactional"), `requested` is true (the reason says "requested"), or
`kind` is "commitment" (the reason says "commitment"). A candidate that is none of these is promotional and still
needs the consent. The exemption covers only the consent it is set on. Without the option the check behaves as in
1.5.0.

9.8 Freshness (S8). `freshness` takes `maxAgeSeconds`, optional. It rejects, with a reason containing "expired", a
candidate whose `freshUntil` is not after `now` (equal to `now` is expired). With `maxAgeSeconds` set it also rejects a
candidate whose `createdAt` is more than that many seconds before `now` (exactly that old is fresh). An unreadable
instant is rejected as expired. A `null` `freshUntil` or `createdAt` is absent (9.1.1), so it does not reject. With neither
`freshUntil` nor a checkable `createdAt` the check skips and says so.
It applies to commitments and to every kind.

9.9 Silence (S9). `silence` reads `candidate.evidence`, which the caller supplies and the gate never reads. With no
evidence it skips. It rejects, with a reason containing "not enough", when `dataPoints` is below `minDataPoints`
(default 5) or `confidence` is below `minConfidence` (default 0.5); a missing value counts as zero, and so does a value
that is not a finite JSON number (a string, a boolean, null, NaN or an infinity). Both thresholds are inclusive. It rejects, with a reason containing "nothing new", when `requireNew` (default true) and
`newSinceLast` is false. An absent `newSinceLast` is not nothing new.

9.10 Crisis quiet (S10). `crisisQuiet` rejects, with a reason containing "crisis", every candidate while `user.crisisUntil`
is after `now`, unless `candidate.kind` is "support". Commitments are refused too. At `crisisUntil` exactly, and after
it, the check passes. It reports `crisisUntil` as the instant it stops rejecting. It spends nothing. It is meant to be
the first check in the list, so that no earlier check can let a message through during the quiet period.

9.11 Dead hours (S11). `deadHours` takes `minSamples` (default 5), `maxActRate` (default 0.2) and `minPriority`
(default "high"). It never rejects; it changes only the surfaces. The hour is the user's local hour in the effective
zone (9.2), or the UTC hour when the user has no zone, the same fallback the budget days use. Its counts are the
user's `hourStats` entry for that hour when the caller supplied one, else the counters `gate.record` wrote for the
hour. When the candidate is on push, its priority is below `minPriority`, the counts total at least `minSamples`
and the acted share is below `maxActRate` (a share equal to the threshold is not below it), push is removed by an
`adjust` outcome whose reason contains "dead hour". When push was the only surface, the decision is allowed with an
empty surface list, and the caller decides what that means. `gate.record(user, candidate, event, at)` with "acted"
or "dismissed" adds one to the counter `hours:<userId>:<hour>:acted` or `:dismissed` for that local hour, kept for
90 days. "dismissed" also records the dismissal that `dismissalCooldown` reads, as in 1.5.0. "delivered" and
"ignored" write no hour counter.

A missing count in `hourStats` or in a stored counter is zero. A count that is not a number makes the total not finite,
and such an hour is not judged dead, so push stays. An allowed decision whose surface list is empty means no delivery:
the caller treats it as held and must not commit it, because a commit spends a budget unit for a message nobody sends.
The hour counters expire 90 days after the counter key is created. A later increment does not extend that expiry; the store
keeps the original expiry when it increments a key that exists. When a counter expires it starts again from zero, even
for an hour that is still counted every day. Nothing decays a counter before it expires, so an hour that was dead months
ago keeps counting until its counter expires.

9.12 Budget tiers (S12). `dailyBudget`, `weeklyBudget` and `monthlyBudget` take `tiers`, a map from tier name to limit.
The effective limit of `dailyBudget` is `user.dailyLimit` when it is a finite number of at least 0 (an explicit
override always wins), else `tiers[user.tier]` when present, else the check's own `limit`. The weekly and monthly
budgets use `tiers[user.tier]` else `limit`, and ignore `dailyLimit`. The tier lookup reads only the tier's own key, so
a tier named like an object property is not a limit. The reason and the near-limit note use the effective limit.

9.13 Kill switch from flags (S13). The policy entry `{ "id": "killSwitch", "flag": <name> }` rejects with a reason
containing "kill switch" while `flags[<name>]` is exactly false. An absent flag, or any value other than false,
stops nothing. The `on` form is unchanged. Giving both `on` and `flag` in one entry is refused when the policy
is compiled.

9.14 Preset `assistantNudge` (S14). The preset takes `dailyLimit` (default 3) and `exemptTypes` (default []), and
expands, in this order, to: `killSwitch` with flag "proactiveEnabled" (9.13), `crisisQuiet` (9.10), `consent` with
`failMode` { push: "closed", feed: "open" } (9.3), `requiresConsent` named "marketing" with `exemptTransactional` (9.7; a transactional, requested or commitment candidate
is not promotional),
`enabled`, `mode` allowing "normal", `snooze` with `defer`, `mute`, `quietHours` with `onMissingTimezone` "reject"
(9.2.1), `trustRamp` for seven days at priority high, `dismissalCooldown` at three dismissals in thirty days with a
seven-day silence and `exemptTypes` (9.6), `freshness` (9.8), `silence` (9.9), `dedupe`, `deadHours` (9.11), and
`dailyBudget` with `limit` set to `dailyLimit`. The numbers are a starting point and a product's own choice, not
findings. The preset does not supply a quiet-hours window. With no `user.quietHours` the quietHours check passes at any hour, so the
caller supplies one (the scaffold uses 22:00 to 08:00). Candidate surfaces default to ["feed"]; a candidate lists "push"
for `deadHours` to act on it. A user with a zone and no quietHours field is allowed at night, as the fixture pins.
Its sources are the four official pages it is built from: the App Store Review Guidelines (4.5.4), the
Android notification permission page, 47 CFR 64.1200, and Regulation (EU) 2016/679 on EUR-Lex. Not encoded: the
local-time window of 47 CFR 64.1200 (for calls, use `usTcpa`), the operating system's notification permission, and the
ease of withdrawing consent under GDPR Article 7(3).

## 10. Client API (non-normative)

These entry points are part of the TypeScript library. They are not conformance requirements, and no fixture covers
them. They are documented so that a port knows what the library does beyond the decision.

10.1 Release and the order of commit and send. `gate.release(decision, input)` gives back what a committed decision
consumed: each budget-like check returns its unit (5.2), and the dedupe check removes its claim (5.5), so the same
event can be sent again. It returns true when that call refunded at least one check. Each check is claimed separately on
`release:<decision id>:<check id>` with an atomic increment before its refund, so concurrent calls refund each check once.
If a refund throws, that check's claim is removed, so a retry refunds the checks that are not done and never repeats one
that is. It never takes a counter below zero. A consumer with no `release` makes the call return false before anything is
written. It is for one order of work only: evaluate, commit, send, and release when the send fails. Under the other order,
evaluate, send, commit, there is nothing to release.

In the TypeScript library, a budget unit refused at commit is given back, so the counter counts committed units only.
Python and Go may keep the refused unit counted: SPEC 5.2 does not say what the counter holds after a refusal, so this is
not a conformance difference. A unit that an earlier check spent in the same commit stays spent when a later check
refuses; release does not undo it, because commit returned false. The dedupe claim behaves the same way, as 5.7 requires.
A read of the counter during a release at zero can briefly show -1 before the clamp restores 0; the final value is exact.

The two orders trade one failure for another. Commit before send: a process that dies between commit and send spends a
unit on a message nobody received, and no release runs because the process is gone. A concurrent winner can make commit
refuse a unit, so the send is refused in time, which is the intended behaviour. Commit after send: a crash after the send
and before the commit loses the unit record, so the budget can be exceeded by one. A concurrent winner can also take the
last unit between evaluate and commit, so commit returns false after the message has already gone out, and the limit is
overshot by one. Choose commit after send where an occasional overshoot costs less than a message that is never sent. Choose
commit before send, with release on a failed send, where a lost message is acceptable and an overshoot is not.

10.2 Synchronous path. `evaluateSync`, `commitSync` and `decideSync` run the decision logic of sections 2 and 3 with the store and
the checks called synchronously. They need a store with synchronous methods (`MemoryStore` has them) and a check with a
synchronous path: `runSync` and `consumeSync` on the checks that read or write the store, or a `run` that returns a
plain value. Every built-in check and preset in this release has one: `killSwitch` and `adaptiveTiming` return a plain
value when their callback does, and an async callback is refused. `commitSync` checks that every consumer has a
`consumeSync` before it spends any unit, so a refusal spends nothing. A store without the sync methods, or a custom
async check, makes the call throw a TypeError whose message says "synchronous", so the caller learns of the mismatch
rather than receiving a decision that skipped the check. A hook that returns a promise is refused on this path for the
same reason. Both paths run one decision core, and the tests compare
them on random inputs for decisions, traces and store state.
