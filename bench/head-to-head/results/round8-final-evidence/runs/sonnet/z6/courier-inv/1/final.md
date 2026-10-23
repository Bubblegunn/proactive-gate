`bot.mjs` is written in the current folder and exports `decide`, `whyNotReceived` and `dryRun`. I ran a test script covering the rules, the explanations, `dryRun` and concurrent workers, and all of it passed. The script is in `/tmp/t6`, not in the project folder. It uses no dependencies, so there is nothing to install. A `package.json` also appears in the folder, but I didn't create it.

I used the Courier skill only for orientation. Quiet hours and caps are fixed local rules here, so the code doesn't call Courier. I didn't check whether Courier's own throttling or delivery windows could replace this logic.

**`decide`**
- Rules run in this order: consent, then quiet hours, then the daily cap.
- Quiet hours run 22:00 to 08:00 in the user's time zone, and the cap is 3 per local calendar day.
- State lives in `STATE_DIR`, one log file per user. A lock around each decision keeps worker processes from over-counting. Six worker processes making 30 attempts for one user delivered exactly 3.
- Every decision, delivered or blocked, is logged with its rule code, earliest delivery time and a plain sentence.
- Retrying a notification id that was already delivered returns `{ send: false }` and isn't counted again. This was my choice, so it isn't in your spec.
- An invalid time zone blocks the notification with the rule code `INVALID_TIMEZONE`. That was also my choice.

**`whyNotReceived`**
- It returns the logged entries in decision order for the `from` to `to` range.
- `availableAt` is the next time the rules would let it through, so a capped notification at 09:00 reports 08:00 the next local day.
- A notification blocked for missing consent has `availableAt: null`, since there's no way to know when consent will come.

**`dryRun`**
- It replays the events in time order with the candidate policy and counts delivered and blocked.
- `quietHours: null` or `dailyCap: null` turns that rule off. Consent is still required.
- It reads nothing from `STATE_DIR` and writes nothing. I checked that the state files were unchanged after a run.

When a user's time zone changes, `decide` counts that user's earlier deliveries by their current time zone.
