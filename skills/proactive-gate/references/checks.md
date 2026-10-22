# Checks, functions and presets

Each backticked name is a check id a policy entry can use as `id`, or a function or preset the gate exposes. The options each check reads are in `spec/schema/policy.schema.json`, and the guide has the examples.

## Refusals and holds

- `killSwitch`: rejects every message while `on` is true, or while the runtime flag named by `flag` is false (pass flags per call).
- `consent`: rejects a user without consent. With `failMode` ({"push": "closed", "feed": "open"}) an unknown consent keeps only the open surfaces.
- `inboundConsent`: an option of `createGate` (not a policy id). Refuses a channel after STOP until START.
- `requiresConsent`: rejects without the consent named by `name` in `user.consents`. `exemptTransactional` lets a transactional, requested or commitment candidate through. `when` limits the check to a local window.
- `enabled`: rejects a profile whose `proactiveEnabled` is false.
- `mode`: rejects a `user.mode` that is not in `allow` (default ["normal"]).
- `snooze`: holds until `user.snoozedUntil`. With `defer` true it defers and gives `retryAt`.
- `mute`: rejects a candidate type in `user.mutedTypes`.
- `intensity`: rejects a priority below the floor for `user.intensity`; `floors` changes the table.
- `quietHours`: rejects inside `user.quietHours`, read in the user's zone. `onMissingTimezone` is "skip" (default) or "reject".
- `trustRamp`: for `days` after `user.createdAt`, only `minPriority` and above pass. Requested and commitment candidates pass.
- `dismissalCooldown`: after `dismissals` in `withinDays`, silences the type for `silenceDays`. `exemptTypes` is never silenced.
- `allowedWindow`: rejects outside `start` to `end` in `timezone` ("user" for the user's own). `priorityFloor` lets urgent messages through.
- `rateLimit`: rejects after `limit` messages in `perSeconds`, counted per `keyBy` ("user" or "channel"). Its refusal carries no `nextAllowedAt`.
- `recentInteraction`: rejects unless the user wrote to the assistant within `withinHours`.
- `freshness`: refuses content at or after `freshUntil`, or older than `maxAgeSeconds` counted from `createdAt`.
- `silence`: refuses thin evidence: fewer than `minDataPoints` (default 5), confidence below `minConfidence` (0.5), or nothing new when `requireNew` is set.
- `crisisQuiet`: while `user.crisisUntil` is in the future, only a `kind` "support" candidate passes. Put it first.
- `dedupe`: one delivery per event per `windowSeconds`, claimed at commit by `candidate.dedupeKey`.
- `utilityFloor`: rejects when the candidate's `pAccept` is below the threshold set by `costFalseAlarm` and `costMissedHelp`.

## Budgets

- `dailyBudget`: at most `limit` per user per local day. `tiers` maps `user.tier` to a limit, and `user.dailyLimit` overrides both.
- `weeklyBudget`: at most `limit` per local ISO week, with `tiers` as above.
- `monthlyBudget`: at most `limit` per local calendar month, with `tiers` as above.
- `windowBudget`: at most `limit` in the window opened by the user's last message, within `withinHours`.
- The daily, weekly and monthly budgets also take `bypassPriority` (a priority that skips the count) and `nearLimit` (the fraction that adds a near-limit note).

## Timing that never rejects

- `deadHours`: removes push in an hour where the user acted on too little of what was sent then (`minSamples`, `maxActRate`, `minPriority`).
- `boundedDeferral`: delays delivery while the caller says the user is busy, by at most `boundSeconds`.
- `adaptiveTiming`: lets the caller move delivery to a later moment.

## Functions

- `gate.record(user, candidate, event, at)`: events "acted", "dismissed", "delivered", "ignored". Feeds `dismissalCooldown` and `deadHours`.
- `gate.release(decision, input)`: after a failed send, gives back what `commit` spent. True only the first time.
- `gate.whenAllowed(input)`: the earliest instant the message could go, found by evaluating again. Spends nothing.
- `gate.evaluateSync(input)` and `gate.decideSync(input)`: the same decision with no await. The store must have synchronous methods, so only `MemoryStore` works.

## Preset

- `assistantNudge`: sixteen checks in a fixed order, with options `dailyLimit` (default 3) and `exemptTypes`. It takes no quiet-hours window of its own, so the caller supplies `user.quietHours`. It is a starting point, not a finding.
