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

## Step 1: check Node

Run `node -v`. It must print 22 or newer. npm on an older Node installs proactive-gate 0.7.3, an older API, without a warning, so tell the user to upgrade Node first.

## Step 2: scaffold the gate

Run `npx proactive-gate scaffold nudge --out .` (add `--legal` with the value us for texts or calls to people in the US: it adds the 08:00 to 21:00 local calling hours). It writes `proactive-gate.policy.json`, `notify.mjs` and `notify.test.mjs`. Keep these rules:

- Call `gate.record` on every "acted" and every "dismissed" event, so the cooldown and the hour counts learn.
- Mark a candidate `requested`, `transactional`, or `kind` "commitment" when it is one. Never mark a promotion that way.
- A digest, briefing or reminder the user signed up for is requested. The app often has no consent field for it, so set `requested` in toInput(); without that the gate holds every send for missing consent.
- Pass the app's own per-call limit as config.dailyNudgeCap to the notify.mjs functions, and set the STATE_DIR environment variable for state that outlives the process; it is read at first use.
- Never leave the time zone empty. Pass `deviceTimezone` as well when the device reports one, because it is read first.

## Step 3: adapt and test

Change the mapping in `toInput()` in `notify.mjs` to your app's shapes, then run `node --test notify.test.mjs`. Every test must pass before `decide()` or `deliver()` goes into a send path.
notify.mjs exports decide (send, reason, reasonCode, surfaces), deliver (calls the app's push and inApp, returns push, inApp, reason, resumeAt), recordDismissal, recordAct and optOut (a type or a channel).
It also exports handleInbound, whyNotReceived (one user's log over a time range), dryRun (last week under another policy) and REASON_CODES, the closed list of reasonCode values.

## Step 4: the details

- `references/guide.md`: the policy format, the decision loop, stores, inbound STOP and START, legal presets and replay.
- `references/checks.md`: one line per check id, the gate functions, and the `assistantNudge` preset.
