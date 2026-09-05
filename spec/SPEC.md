# proactive-gate behaviour contract

Version: see `SPEC_VERSION`. The key words MUST, MUST NOT, SHOULD and MAY are to be read as in
RFC 2119. An implementation conforms when it passes every fixture under `fixtures/` for its
declared spec version, minus the fixtures listed in its `skip/<impl>.txt` file, which MUST be
empty at a stable release.

Versioning: patch releases add fixtures that existing implementations already pass; minor
releases add a check or field and mark it with `since`; major releases change an expectation.
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
without incrementing.

5.4 `commit` on a decision that is not allowed MUST return false without touching the store.

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
