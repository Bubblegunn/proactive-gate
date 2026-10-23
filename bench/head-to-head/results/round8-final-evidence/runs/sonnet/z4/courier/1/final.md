`bot.mjs` is written in the current folder and my check script passes. It has no dependencies, so `package.json` is unchanged. Nothing is actually sent.

**What `decide` does**
- **`requested` and `reminder`:** always delivered, once per candidate id. They never count against `dailyNudgeCap`, and quiet hours and the new-user rule don't apply to them.
- **`inferred`:** blocked in three cases.
  - **New user:** blocked for 48 hours after the later of `createdAt` and `profileCreatedAt` (`new_user_grace`). Unparseable dates are treated as a new user.
  - **Quiet hours:** blocked from 21:00 to 09:00 in the user's timezone (`quiet_hours`). An invalid timezone falls back to UTC.
  - **Daily cap:** blocked once `dailyNudgeCap` is reached for the user's local day (`daily_cap_reached`). A missing or invalid cap is treated as 0.
- **Repeat candidates:** a candidate id that was already delivered returns `already_delivered`. Decisions that don't send are not recorded, so the app can ask again later.
- **Unknown origin:** returns `unsupported_origin`.
- **`REASON_CODES`:** `requested_ready`, `reminder_due` and `nudge_allowed` are the codes returned when `send` is true. The other five are the not-sent codes: `already_delivered`, `new_user_grace`, `quiet_hours`, `daily_cap_reached` and `unsupported_origin`. None of them says "error".

**State**
- Stored under `STATE_DIR`, created if missing. If `STATE_DIR` is unset, it uses `.state` in the working directory.
- Each user gets one JSON file, written atomically so it survives a restart.
- A per-user lock (a directory created with `mkdir`) keeps several worker processes safe. A lock held longer than 10 seconds counts as stale and is taken over.

**What I checked** (`/tmp/bot-check.mjs`, outside the project)
- The cases above: requested, repeat, new user, quiet hours, cap, reminder ignoring the cap, and the next day resetting the count.
- Four processes made 20 inferred attempts at once with a cap of 3, and exactly 3 were sent.

The 48-hour grace, the 21:00–09:00 quiet window and cap 0 for an invalid value are my own choices, since the spec didn't give them. They are constants at the top of the file if you want different values.
