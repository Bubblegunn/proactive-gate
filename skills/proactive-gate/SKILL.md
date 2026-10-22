---
name: proactive-gate
description: Use when you need to send reminders, texts, emails or pushes to users from an agent, cron job or webhook and must limit how many messages they get, respect quiet hours, do not message people at night, handle opt-out and STOP, keep to legal contact hours, explain why a user got nothing, or replay last week under a new policy. The proactive-gate library checks consent, time zone, quiet hours, snooze and budgets before each unsolicited message and gives every refusal a reason and a retry time.
---

# proactive-gate

Put a gate in front of every message your agent sends on its own initiative. The gate decides whether a message may go now and never sends anything. A refusal names the check, says why, and gives the earliest retry time when there is one.

## When to use it

- You are adding a reminder, nudge, digest, alert or follow-up the user did not just ask for.
- The user asks for quiet hours, a message limit, a pause, consent checks or opt-out handling.
- The message leaves from a loop, a schedule or a webhook, not as the answer to something the user just wrote.

## Default: write the gate inline

Write the gate in ONE file, the file the task names. No install, no scaffold, no reading of library source, no separate test file. Write the file, then run one self-check as a single inline command (`node -e` or a heredoc), then answer. Aim at 5 turns after this skill loads; the one inline check covers rules 3 to 6, and your answer says which rule it did not check. The gate must follow these rules:

1. Data. Use only the fields the task or the app gives. Never invent a field, a key or a purpose name. A missing field is unknown, not "no".
2. Consent. When the data carries a consent field, false or absent means off. When it carries no consent field at all: (a) a message the user signed up for or asked for (digest, briefing, reminder) is allowed; (b) a newsletter or other email or in-app message to people the request calls subscribers, customers or list members is allowed unless an opt-out is recorded (a true opt-out field for that user and channel, or a STATE_DIR record, rule 7; an opt-out field the data carries but leaves missing for a user is unknown, so hold); (c) a promotion by text, call or autodialer needs an explicit opt-in in the data, whatever the request calls the people; (d) any other promotion and any other unknown case is held. Opt-in exemption: with no consent field, when the request's functions can only record opt-outs (unsubscribe, STOP), a missing opt-in does not hold an email or in-app message (no opt-in can ever exist); allow it when no opt-out is recorded, unless (b) holds, and say so. A recorded opt-out still blocks. It never lifts (c). Say the assumption in one sentence in your answer.
3. Never hold everything. Before you finish, call the exported function with exactly the fields the task lists and confirm that one message is allowed.
4. State. Read STATE_DIR inside every call, not at import and not once and cached. Create it. Keep one record per user and per message id. Every worker process shares it and it survives a restart. Write with an atomic step (temp file then rename, or an exclusive create) so two workers cannot both win.
5. Redelivery. Key every send by message id: the same id gets the same answer and spends nothing twice. Claim before sending. Give the claim back only when the send definitely did not happen (the gate refused it, or it failed before leaving). When the outcome is unknown, keep the claim.
6. Time. Use the recipient's local time (Intl with the IANA zone; the device zone first when the data has one). An unknown or invalid zone is held, never guessed. A window includes its start minute and excludes its end minute, across DST; a window whose start is later than its end wraps past midnight. A local day or week is the recipient's own.
7. Opt-out. Match STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE, OPT OUT, OPT-OUT and OPTOUT as the whole message, any case, outer punctuation and extra spaces ignored; "stopping" is not STOP. Opt-out is per channel, holds in every process at once and beats every other rule for unsolicited and promotional messages. It acts on the opt-out the data carries (a field or an inbound STOP), never on whether the outgoing message body holds an opt-out notice. START or UNSTOP turns it back on. The account-page opt-out writes the same record.
8. Refusals. Return a plain sentence that names the rule and gives the retry time when there is one, never an internal code alone.
9. Time-critical messages. Something the user asked to be told at a time may use a reserved budget. Opt-out, quiet hours and legal hours still apply to it.
10. Numbers you chose (hours, caps, cooldowns) go in your answer, one line each.
11. Blocks. Rules 1 to 10 always apply: consent, opt-out, recipient-local legal and quiet hours, a valid zone and the caps still block. Rule 11 stops you from adding a block that is not in them. Add a new block only when the request states it, or when a law or policy text the request names requires it of the sender before sending. A check on the body of the outgoing message (a required notice, a word, a length) is a recommendation unless the request or a named law requires it: allow the message and write one line "not enforced: (the check)" in your answer. When unsure whether such a check is required, do not block. Do not refuse a valid send for a body check. This applies only to checks on the message body: consent (rule 2) and opt-out (rule 7) are not new blocks, and when unsure whether consent is present, hold; the only exception is the opt-in exemption of rule 2.

## Use the library instead when

The project already imports proactive-gate, or the user asks for a policy file, a scaffold, a log of why a user got nothing, or replay. Run `node -v` first: it must print 22 or newer (npm on an older Node installs proactive-gate 0.7.3, an older API, without a warning). Then run `npx proactive-gate scaffold nudge --out .` (add `--legal us` for texts to people in the US). Mark a candidate `requested`, `transactional` or kind "commitment" when it is one, and never mark a promotion that way. Set STATE_DIR for state that outlives the process. Call `gate.record` on every "acted" and "dismissed" event so the cooldown learns, and pass `deviceTimezone` when the device reports one. Change `toInput()` in `notify.mjs` to the app's shapes and run `node --test notify.test.mjs` before `decide()` or `deliver()` goes into a send path.
notify.mjs exports decide (send, reason, reasonCode, surfaces), deliver (calls the app's push and inApp, returns push, inApp, reason, resumeAt), recordDismissal, recordAct and optOut (a type or a channel).
It also exports handleInbound, whyNotReceived (one user's log over a time range), dryRun (last week under another policy) and REASON_CODES, the closed list of reasonCode values.

- `references/guide.md`: the policy format, the decision loop, stores, inbound STOP and START, legal presets and replay.
- `references/checks.md`: one line per check id, the gate functions, and the `assistantNudge` preset.
