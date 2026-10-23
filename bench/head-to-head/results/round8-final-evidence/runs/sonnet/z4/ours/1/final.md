`bot.mjs` is written in the current folder. It exports `decide` and `REASON_CODES`, and it needs no dependencies. I ran one self-check with a fresh `STATE_DIR`, and the outputs matched the rules below.

**What I checked:** A requested item was delivered. A redelivery of the same id was refused. Two inferred nudges went out and the third hit the cap of 2. A new user and an invalid timezone were each held. A reminder was delivered.

**What I didn't check:**
- Several worker processes running at once.
- A restart. I didn't run `decide` again in a new process on the same `STATE_DIR`.
- Daylight-saving boundaries.

**Rules in `decide`:**
- **Requested and reminder:** both are sent. Neither counts toward the daily cap, and no quiet hours apply because the request states none.
- **Inferred:**
  - Held for new users. A user is new if the later of `createdAt` and `profileCreatedAt` is less than 3 days old.
  - Held if the timezone is invalid.
  - Held if `dailyNudgeCap` is missing or not a whole number of 0 or more.
  - Held once the user's own local-day count reaches `dailyNudgeCap`.
- **Redelivery:** a message id that was already delivered gets `send: false` with `already_handled`, so nothing is sent or counted twice. A held message gives its claim back, so it can be retried later.
- **State:** shared files in `STATE_DIR`, read on every call, with atomic claims and counts.

**Numbers I chose:**
- New-user grace period: 3 days with no inferred nudges.
- No other numbers. The daily cap comes from `config.dailyNudgeCap`.

**Not enforced:**
- Opt-out and consent. The app gives no consent or opt-out field, so nothing is blocked on them.
- Quiet hours. The request states none.

**Reason codes:** `REASON_CODES` has 8 entries:
- `sent`
- `already_handled`
- `new_user_no_suggestions`
- `daily_nudge_cap_reached`
- `unknown_timezone`
- `unknown_cap`
- `unknown_user_data`
- `unknown_candidate`

The gate-kit helpers are appended at the end of the file.
