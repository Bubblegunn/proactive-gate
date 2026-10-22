I wrote `bot.mjs` in the working directory. It exports `createPushGate()`, has no dependencies, and passed 20 behaviour checks run from a temp file outside the repo, which I deleted afterwards. Nothing was sent.

**What the gate does, in order:**

1. **Quiet hours → `quiet_hours`.** The gate reads the local clock in `user.timeZone`. Start is inclusive and end is exclusive, so 22:00 is blocked and 07:00 is allowed. Windows that cross midnight work. If `quietStart` equals `quietEnd`, quiet hours are off.
2. **Daily cap → `daily_cap_reached`.** Pushes are counted per local calendar day in the user's zone, not per rolling 24 hours. Local midnight resets the count. A `dailyCap` of 0 blocks everything.

Each allowed call is recorded as a sent push. A quiet-hours or cap denial is not recorded. History is kept in a `Map` keyed by `user.id`, and entries older than two days are dropped.

**Checks that pass:**
- Quiet-hours boundaries for Tokyo, including the midnight-crossing window and the non-crossing window.
- The cap is per local day, and a push at 23:50 does not block one at 00:10.
- The quiet-hours denial does not use up the cap.
- The same UTC instant is blocked in New York at 23:00 and allowed in Tokyo at 12:00.
- Two pushes on the New York date of 21 Oct, then a third push after New York midnight is allowed.
- Users and gate instances do not share state.
- Malformed times such as `24:00` or `7am` throw a `TypeError`.

**Choices to check:**
- **No minimum spacing between pushes.** Your two complaints were night wake-ups and too many per day, so I covered those two directly. Apple's and Google's guidance also discourages bursts. A minimum gap would be a third rule with its own code, and I left it out because you did not ask for it.
- **No urgency override for quiet hours.** The signature has no urgency field, so every push is held during quiet hours. Apple's Time Sensitive and Google's high-priority channels are the usual way to let a push through at night. Tell me if the agent should be able to mark a push as urgent.
- **Quiet-hours denials don't count toward the cap.** The user gets no push either way, so the cap only counts pushes that were actually sent.

The Knock best-practice rules I read (`rules/notification-system-implementation.md` and `rules/channel-specific-notifications-guidelines.md`) support this design: quiet hours sit before frequency caps in the preference hierarchy, and push should be reserved for items that are urgent and actionable. Those rules do not cover Apple's or Google's own notification guidelines, so I did not cite those documents.
