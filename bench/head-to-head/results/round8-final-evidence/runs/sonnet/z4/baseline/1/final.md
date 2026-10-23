`bot.mjs` is written and works. It has no dependencies, so `package.json` is unchanged.

**Rules in `decide`**
- **requested and reminder:** these always send. They skip every nudge limit, even in quiet hours or for a new user, and they don't count toward the daily cap.
- **inferred:** these are held back, with a reason code, when any of these applies:
  - **New user:** the account or the notification profile is less than 24 hours old.
  - **Quiet hours:** the user's local time is between 21:00 and 08:00.
  - **Spacing:** the last inferred nudge was less than 4 hours ago.
  - **Daily cap:** the user already has `dailyNudgeCap` inferred nudges today. The day is the user's local day.
  - **Bad data:** the timezone or dates are invalid, or the cap is missing or 0.
- **Repeats:** a candidate id that was already delivered is not sent again (`already_delivered`).
- **Unknown origin:** it returns `unsupported_origin`.
- **Failures:** if the lock times out or the state can't be read or written, it returns `busy_try_again` instead of throwing. For requested and reminder candidates this means they don't send on that call.

`REASON_CODES` lists every code `decide` can return: `delivered`, `already_delivered`, `new_user_grace_period`, `daily_cap_reached`, `quiet_hours`, `too_soon_after_last_nudge`, `nudges_unavailable`, `unsupported_origin`, `busy_try_again`. None of them says "error". A successful send returns `{ send: true, reasonCode: 'delivered' }`.

**State:** each user gets one JSON file in `STATE_DIR`, written atomically. A lock file per user (stale after 10 seconds) makes concurrent workers safe, and the files are still there after a restart.

**Checks I ran**
- A scripted sequence covered requested, reminder and inferred candidates, a repeat id, new-user and quiet-hours cases, spacing and the daily cap. Every result was as expected and every returned code is in `REASON_CODES`.
- Twelve separate processes called `decide` for the same user at the same instant. Exactly one got `send: true` and the other eleven were blocked by the spacing rule.
- A new process afterwards still saw the saved state.
- I did not test the stale-lock cleanup, the `busy_try_again` paths, or the cap with spacing out of the way.

I chose the 24-hour new-user period, the 21:00–08:00 quiet hours and the 4-hour spacing myself because the brief didn't give them. They are constants at the top of the file if you want different values.
