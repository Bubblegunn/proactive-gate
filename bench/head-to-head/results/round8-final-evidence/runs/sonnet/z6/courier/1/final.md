`bot.mjs` is written in the current folder and exports `decide`, `whyNotReceived` and `dryRun`. I tested it with throwaway scripts in `/tmp`. I did not leave a test file in the repo, and no dependencies were needed.

What I checked:
- **Quiet hours:** 21:59 is delivered, 22:00 is blocked, 07:59 is blocked, 08:00 is delivered (Europe/Istanbul).
- **Daily cap:** the 4th notification on one local day is blocked, and the next local day starts counting again.
- **No consent:** blocked.
- **Concurrency:** 6 separate processes sent 60 notifications for one user on the same day. Exactly 3 were delivered.
- **Restart:** `whyNotReceived` run in a fresh process read the earlier decisions correctly.
- **Dry run:** results were sensible, and it created no state directory.

How it works:
- **`decide`:** checks consent, then time zone, then quiet hours (22:00 inclusive to 08:00 exclusive local), then the cap of 3 per local day. Blocked notifications don't count toward the cap. It returns `{ send }`.
- **Retries:** a repeated notification id for the same user gets the original answer and isn't counted twice.
- **State:** each user has an append-only log file under `$STATE_DIR/users/`, and the outcome is recomputed from that log in file order. This needs no lock between workers, and a crashed writer can't corrupt later entries. Each decide reads that user's whole file, which is fine at normal volumes.
- **`whyNotReceived`:** returns one entry per notification in the order considered. `ruleCode` is one of `NO_CONSENT`, `INVALID_TIMEZONE`, `QUIET_HOURS` or `DAILY_CAP`. `availableAt` is the earliest delivery time. It accounts for the cap landing on the day quiet hours end, and it is null for no consent or an invalid time zone. `text` is one sentence addressed to the customer, with local times.
- **`dryRun`:** a pure simulation that never touches `STATE_DIR`. It replays events in time order with the candidate policy. A `null` quiet hours or cap turns that rule off.

Choices I made where your spec was silent:
- **Consent:** only `consent === true` counts. Anything else is treated as no consent.
- **Invalid time zone:** blocks the notification, with its own rule code.
- **Policy input:** a malformed policy, such as a bad `HH:MM` or a non-integer cap, throws instead of being guessed at.
- **Repeated ids in `dryRun`:** a repeated notification id inside the events reuses the first outcome.
- **Equal start and end:** quiet hours with `start` equal to `end` is an empty window.
- **Policy changes:** each logged decision stores the policy it was made under. Changing the real rules later won't rewrite how support sees past decisions.
