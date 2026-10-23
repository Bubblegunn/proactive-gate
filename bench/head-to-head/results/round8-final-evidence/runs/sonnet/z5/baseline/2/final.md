`bot.mjs` is written in the current folder. It needs no dependencies. I ran it against a temporary `STATE_DIR` with 15 cases and each one gave the expected result. It sends nothing. It only returns a decision.

`decide` stays quiet in each of these cases. The reason is a short plain sentence:
- **Crisis:** `context.crisis` is true.
- **Focus mode:** `focusMode` is on.
- **Night:** the user's local time is between 22:00 and 08:00. An unknown timezone also stays quiet, because the local time can't be checked.
- **Weak finding:** `dataPoints` is under 5, or `confidence` is under 0.6.
- **Bad hour:** `hourStats` for the current local hour has at least 5 samples and 70% or more were dismissed.
- **Already shown:** the same candidate `id` was delivered before, or the same `insight.key` was delivered in the last 14 days.
- **Too frequent:** the last message was under 3 hours ago, or 2 messages were already shown that local day.

When it does send:
- **Surfaces:** it uses `["push", "inApp"]` if `confidence` is at least 0.85 and the user doesn't usually ignore this hour. Otherwise it uses `["inApp"]` only.
- **Delivery record:** every send is saved at once, so it counts as delivered.

State is one JSON file, `gate-state.json`, in `STATE_DIR`. It is created if missing and written atomically. Calls within one process run one at a time. I tested a restart: a new process still refused a finding delivered earlier. Two separate processes sharing one `STATE_DIR` are not protected against racing each other. If `STATE_DIR` is unset, `decide` throws.

The thresholds are my own picks, not from your spec. They are constants at the top of `bot.mjs` if you want to change them.
