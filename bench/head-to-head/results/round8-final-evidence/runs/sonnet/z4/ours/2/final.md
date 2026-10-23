`bot.mjs` is written, with the gate kit appended, and a self-check passed. I did not check concurrent workers, a restart, or a DST edge.

What the check showed:
- **Requested:** a "requested" candidate is sent, and sending the same id again returns send again.
- **Inferred cap:** with `dailyNudgeCap: 2`, the first two inferred nudges are sent and the third is held with `daily_cap_reached`. A repeat of the first id is sent again without using up a cap slot.
- **New user:** an inferred nudge for a user whose account was created one hour earlier is held with `new_user_grace`.
- **Bad timezone:** an inferred nudge with an invalid timezone is held with `timezone_unknown`.
- **Reminder:** a reminder is sent.

`REASON_CODES` has 7 codes: `new_user_grace`, `daily_cap_reached`, `timezone_unknown`, `user_age_unknown`, `cap_unknown`, `origin_unknown`, `input_incomplete`. `decide` returns `reasonCode: null` when `send` is true.

How `decide` works:
- **Requested and reminder:** always sent, with no cap and no quiet hours, since the request states none.
- **Inferred:**
  - **New user:** held for 24 hours after the later of `createdAt` and `profileCreatedAt`.
  - **Daily cap:** after that, limited to `dailyNudgeCap` per day in the user's own timezone.
  - **Bad or missing data:** an unreadable date, a missing or invalid cap, or an invalid timezone holds the nudge.
- **State:** one record per user and per message id, plus a daily counter per user. Both are written atomically in `STATE_DIR` and read inside every call.
- **Repeats:** a repeated id gets the same answer and uses no extra cap. A held id is released, so it can be sent later.

Numbers I chose:
- New-user hold: 24 hours.
- Cap scope: only "inferred" nudges count toward `dailyNudgeCap`.

Not enforced: opt-in and opt-out. The app gives no consent or opt-out data, and nothing in the request says these messages need an opt-in. Add an opt-out check if the app starts passing one.
