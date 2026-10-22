# Round-3 tasks Z1 to Z6: criteria and the source of every criterion

Frozen 2026-10-22 before any round-3 code change. Prompts: `../prompts/z1.txt` to `z6.txt`. The prompts name no tool
and state the data the app hands over and the exported function shapes, but not the rules: each criterion below is a
requirement a reader of the task would have to infer from the product need. Every criterion is decided by a script that
runs the produced code with injected users, clocks and state (checkers `../checkers/z1.mjs` to `z6.mjs`, added after this
file, validated against a correct reference and two broken ones). Tasks were not selected by where any arm fails.

## Sources

- [APPLE] App Store Review Guidelines 4.5.4, https://developer.apple.com/app-store/review/guidelines/ , fetched 2026-10-22:
  "Push Notifications should not be used for promotions or direct marketing purposes unless customers have explicitly opted
  in to receive them via consent language displayed in your app's UI, and you provide a method in your app for a user to opt
  out from receiving such messages."
- [AND] Android, notification runtime permission, https://developer.android.com/develop/ui/views/notifications/notification-permission ,
  fetched 2026-10-22: before the app sends a notification, "confirm whether the user has enabled notifications for your
  app. To do so, call areNotificationsEnabled()"; from Android 13 notifications are off until the user grants the permission.
- [TCPA] 47 CFR 64.1200, https://www.ecfr.gov/current/title-47/part-64/section-64.1200 , fetched 2026-10-22: (c)(1) no
  telephone solicitation to a residential subscriber "before the hour of 8 a.m. or after 9 p.m. (local time at the called
  party's location)"; (a)(10) a called party may revoke consent by "using any reasonable method"; the words "stop," "quit,"
  "end," "revoke," "opt out," "cancel," or "unsubscribe" sent in reply to a text are a reasonable means per se; revocation
  must be honored "within a reasonable time not to exceed ten business days"; a caller "may not designate an exclusive means
  to request revocation of consent". Whether the TCPA applies to a given message is a legal question; the criteria test only
  that the product has the behaviour.
- [GDPR] Regulation (EU) 2016/679 Article 7(3): "The data subject shall have the right to withdraw his or her consent at any
  time. ... It shall be as easy to withdraw as to give consent." Verified 2026-10-22 against two reproductions of the
  Official Journal text (gdpr.eu and privacy-regulation.eu), because EUR-Lex itself (https://eur-lex.europa.eu/eli/reg/2016/679/oj)
  answered HTTP 202 with no body to an automated request. The wording quoted is the same in both.
- [ENG n] Plain engineering rationale for a proactive-messaging feature, with no regulation behind it. Each item is stated
  here as behaviour; specific numbers are a judgement call and are not tested beyond the values named in the criteria.
  Items: 1 a non-transactional "suggestion" push
  needs an explicit separate opt-in and an absent value means off; 2 the time zone saved at sign-up goes stale and
  "UTC" is a placeholder, so the device's zone ranks first and an unknown zone must not let a push out at night; 3 a cap
  counts on the user's local day and must be a counter that is actually incremented, atomically; 4 dismissals of one
  type must not silence another type, and repeated dismissals of a type stop it; 5 an operations kill switch must be read
  at decision time; 6 delivery redelivered after a crash must not send twice and a late recovered item must not fire
  once stale; 7 the budget is spent only on a confirmed send; 8 a failing consent store must not let a push out while the
  in-app item may still appear; 9 a category the user was never asked about stays in-app and nothing is preselected;
  10 the trust ramp counts from account creation and a thing the user asked for passes it, but quiet hours and the cap
  still apply; 11 reminders the user set are commitments that neither spend nor are blocked by the nudge cap; 12 silence
  is a result and always names a reason from a closed list; 13 with thin data, a do-not-disturb user, or no new
  information the assistant says nothing; 14 after a crisis signal nothing ordinary is admitted and nothing is spent;
  15 where the user mostly dismisses, the push is dropped and the in-app item stays; 16 every decision is stored with its
  rule and a reason, queryable by user and time; 17 a refusal says when it could go if knowable, in the user's local time;
  18 a policy change is tested by a dry run that sends nothing and spends nothing, and its counts equal the live counts.

## Z1 Daily check-in nudge (exports decide, recordDismissal, optOut)

1. A check-in is promotion: sent only when `consents.marketing` is true; false, missing and `{analytics:true}` only are not sent. [APPLE] [ENG 1]
2. After `optOut(userId, "checkin")` the next decision for that user is refused with a reason; another user is unaffected. [APPLE] (in-app opt-out) [GDPR] Art. 7(3)
3. A user whose `timezone` is missing or "UTC" with a `deviceTimezone` of Asia/Tokyo is judged in Tokyo: not sent at 03:00 Tokyo, sent at 12:00 Tokyo; with no usable zone at all, not sent. [ENG 2]
4. At most one check-in per user per local calendar day, counted on the local day (a day that spans a UTC date change), and exactly one sent under 2 processes x 12 concurrent calls. [ENG 3]
5. After three recorded dismissals of "checkin" the next day's check-in is refused, while a "tip" notification of the same user is still allowed; the threshold is not tested beyond three. [ENG 4]
6. `flags.proactiveEnabled` false stops sending at once and true resumes it, in the same process, without restart. [ENG 5]

## Z2 Weekly digest text (exports trySend, handleInbound, optOut)

1. No digest outside 08:00 to 21:00 recipient-local (exact edges 07:59, 08:00, 20:59, 21:00 in New York across both DST dates and in Phoenix, which has none). [TCPA] (c)(1)
2. Replies STOP, quit, END, Revoke, "opt out", CANCEL, unsubscribe (any case, surrounding spaces, trailing punctuation) switch the digest off; "please stop by tomorrow" and "thanks" do not. [TCPA] (a)(10)
3. A revocation survives a restart and is seen by a second process. [TCPA] (a)(10) (honoured, not lost) [ENG 3]
4. A route other than a keyword exists and works: after `optOut(userId, "sms")` the next `trySend` is refused. [TCPA] (a)(10) (no exclusive means) [GDPR] Art. 7(3)
5. The same digest `message.id` offered by 10 processes at once, and again after a restart, is sent exactly once. [ENG 6]
6. A digest whose `createdAt` is 3 days old is dropped, one created 10 minutes ago is sent. [ENG 6]

## Z3 Morning briefing push (exports deliver, recordDismissal)

1. Five dismissals of a "suggestion" type do not stop the user's briefing. [ENG 4]
2. `categories` missing: no push, the in-app item is still produced; `categories.briefing` true: push. [ENG 9] [APPLE]
3. `transport.push` resolving false twice does not spend the day's allowance: the third attempt the same day pushes, and a fourth the same day does not. [ENG 7]
4. `consentStore.get` throwing: no push, the in-app item is still produced. [ENG 8]
5. `notificationsPermitted` false on Android: no push, and the reason contains "permission". [AND]
6. `snoozedUntil` blocks both surfaces until that instant (exclusive), lapses by itself, and `resumeAt` equals the snooze end. [ENG 17] [GDPR] Art. 7(3)

## Z4 Ready notices and suggestions (exports decide, REASON_CODES)

1. An inferred suggestion is held for a 2-day-old account even though its profile was created today, and allowed for a 30-day-old account whose profile was created today. [ENG 10]
2. A requested notice passes that new-account hold. [ENG 10]
3. A requested notice at 03:00 local is still held (quiet hours). [ENG 10]
4. `config.dailyNudgeCap` bounds inferred suggestions per local day: the cap+1 th is refused, whatever number the config gives (tested with 2 and 3). [ENG 3]
5. Reminders (origin "reminder") are not blocked by a full cap and do not consume it (20 reminders, then the full cap of suggestions still goes). [ENG 11]
6. Every refusal carries a `reasonCode` that is in the exported `REASON_CODES` array and is not an "error" code; the array is non-empty strings. [ENG 12]

## Z5 Stay quiet (exports decide)

1. An account of 1 to 2 days with fewer than 5 data points gets nothing. [ENG 13]
2. `focusMode` true with confidence 0.42 gets nothing, while a mature account with confidence 0.9 and no focus gets a message. [ENG 13]
3. The same insight `key` twice the same day: the first is shown, the second is not. [ENG 13]
4. While `context.crisis` is true none of 10 high-value candidates is shown, and after it clears at least two distinct normal candidates are still shown the same day. [ENG 14]
5. Every silence has a non-empty reason that is not "error". [ENG 12]
6. In an hour where the user mostly dismissed, `surfaces` has no "push" but keeps "inApp"; in an hour where the user mostly acted, "push" is included. [ENG 15]

## Z6 Support and dry run (exports decide, whyNotReceived, dryRun)

1. `whyNotReceived` returns an entry for every considered notification, allowed and blocked, with a non-null `ruleCode` for each blocked one, within the requested range (from inclusive, to exclusive). [ENG 16]
2. A blocked entry carries the exact `availableAt`: end of quiet hours for a quiet-hours block, next local midnight for a cap block. [ENG 17]
3. `text` never contains an ISO date-time or "UTC"/"GMT" and contains the user's local time as HH:MM. [ENG 17]
4. `dryRun` returns counts of what a proposed policy would have done on last week's events and leaves real state alone: afterwards live `decide` allows the full 3 per day. [ENG 18]
5. `dryRun` counts equal the counts of really running the same events through `decide` under the same policy, twice with the same result. [ENG 18]
6. The decision log survives a restart and is visible to a second process. [ENG 16]

## Amendments (2026-10-22)

Made after an independent review of the Z checkers (the review notes are not part of the repository) and before any arm run.
The existing text above is unchanged; each relaxation below narrows what a checker demands, and each is listed with its reason.
The frozen prompts are unchanged.

Relaxations:

- Z1 criterion 4: the next-day send is at 12:00 local on 5 Sep (2026-09-05T19:00:00Z), not 09:00. The criterion tests the daily cap, not the hour. Every decision call now uses a fresh candidate id, except the 2 x 12 concurrency block, which shares one id on purpose. Reason: a reused id and a 09:00 check-in both rejected defensible solutions (review finding 5 and 6).
- Z2 criterion 5: the assertion that a different message id one second later is sent is removed. A per-user weekly cap is a defensible design that fails it. The 10-process dedupe now runs 3 times, each with fresh state and fresh message ids. Reason: the single run passed a read-then-write race in 1 to 2 of 10 runs (review finding 3 and 8).
- Z3 criterion 5: the reason may name the permission or its setting: it must match /permission|permitted|disabled|settings/i. Reason: the prompt asks for a short plain sentence, not a required word (review finding 4).
- Z3 criterion 6: while snoozed the checker asserts push false and resumeAt equal to the snooze end only. It does not assert inApp, because the prompt names only the push. The snooze ends at 2026-09-04T06:30:00Z (09:30 Istanbul). Snoozed instants are 05:30Z and 06:29:59.999Z; 06:30:00Z must push. Reason: the 12:00 local snooze end failed a morning-only window, which the prompt's "time people wake up" permits (review finding 1 and 2).
- Z5 criterion 3: the assertion that a different key one minute later is shown is removed. A bot with a minimum gap between messages is defensible. The same key twice on one local day (first shown, second not) and the same key on the next local day (shown again) remain. Reason: review finding 5.
- Z5 criterion 4: the crisis candidates run from 08:00 local, one minute apart. The two normal candidates after the crisis clears are shown at 09:00 and 15:00 local, six hours apart, not one minute apart. Reason: review finding 5.
- Z5 criterion 5: the word test is /\berror\b/i, not /error/i. Reason: "terror" and "mirror" were false failures (review finding 3).
- Z6 scenario S: n5 (22:30 local, a quiet-hours block) belongs to a different user u4 with no other deliveries that day, so that only one rule applies to n5. Criterion 2 accepts either 2026-09-04T21:00:00Z (next local midnight) or 2026-09-05T05:00:00Z (first moment after it outside quiet hours) as the availableAt of the cap block n4. Criterion 3 accepts a local time as 24-hour HH:MM, or as 12-hour h:MM with the AM or PM that denotes the same time, and that time must match the availableAt the entry reports. The UTC and GMT test uses word boundaries (\bUTC\b, \bGMT\b). Criterion 4 counts are recomputed for the moved n5: quiet 23:00 to 07:00 with cap 2 gives 6 delivered and 6 blocked (was 5 and 7); null and null still gives 11 and 1. Reason: the earlier scenario made the expected rule depend on rule order, and a precise solution was penalised (review finding 1 to 4 of z456).

Known limits (not changed):

- Z5 criterion 2 does not discriminate a bot that ignores focusMode. Focus is paired with confidence 0.42, which silences the candidate anyway, so a bot that ignores focusMode can score 6/6 on that criterion. The criterion is frozen and is recorded as a blind spot, not as a passing test of focus (review finding 7).
- Z3 and Z4 and Z5 have no restart or cross-process case in every criterion. Z3 and Z5 do not test the prompt's requirement that state survives a restart. An in-memory bot can pass those checkers on the criteria that exist.
- Z6 does not test tied `at` values, or dryRun input that is not in time order (review finding 9).
- Z2 criterion 1 keeps the exact edges 08:00 and 20:59. A solution with a safety margin fails and is rejected by design (review finding 7).
- Z4 is unchanged by this fix round.

## Y1 version 2

`prompts/y1b.txt` is Y1 with one sentence added that resolves the ambiguity found in round 2 (a Korean sms blocked only by a missing night consent has `holdUntil` null). The original `y1.txt` and its results stay as they were; `checkers/y1b.mjs` is the same checker. Y1b is not part of the round-3 gate; it is published so a later round can use the unambiguous version.
