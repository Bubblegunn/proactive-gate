`bot.mjs` is written, and a 22-case check script passed every case (it imports `bot.mjs` and sends nothing). The script is at `/tmp/t.mjs` and I did not add it to the project.

**How the function decides, in order:**
- **Bad input:** if `now` is not a valid Date, `message.kind` is not one of the two values, the text is empty, or `user` is missing, the text is held. Any exception is caught and held as `internal-error`. The function never throws.
- **Transactional:** always allowed, whatever the hour, timezone or opt-in state. I chose this because you described these texts as ones the customer asked for.
- **Marketing, opted out:** any `optedOutAt` value holds the text, even one that doesn't parse.
- **Marketing, no consent:** it needs `sms.optedIn === true`. A missing `sms` object or a missing value counts as no consent.
- **Marketing, bad timezone:** a missing or invalid `timeZone` holds the text. It never guesses UTC.
- **Marketing, calling hours:** allowed from 08:00 up to but not including 21:00 in the customer's local time. This follows 47 CFR 64.1200, and I apply it to India and Japan as well.

**Rule identifiers:**
- `invalid-time`
- `invalid-message-kind`
- `empty-text`
- `invalid-user`
- `opted-out`
- `opt-out-unreadable`
- `no-consent`
- `no-valid-timezone`
- `outside-calling-hours`
- `internal-error`

**What the check covered:**
- **Hour edges:** the hour boundaries pass in Chicago (summer and winter), Tokyo and Kolkata.
- **Hold reasons:** each hold reason is exercised.
- **Always-allowed cases:** transactional texts are allowed at night, with no timezone, and after an opt-out.

I did not test the clocks-change night itself (the autumn clock change in Chicago is on 2026-11-01).

**What it does not do:**
- **No body checks:** the function does not check the message text. CTIA recommends that marketing texts name the sender and say how to opt out (for example "Reply STOP"). Your sending code should include that.
- **STOP handling:** it does not process incoming STOP replies. It only reads `optedOutAt`, so your inbound handler has to set that field.
- **No re-opt-in:** once `optedOutAt` is set, marketing stays held until you clear that field.
- **Stricter state rules:** some US states (for example Florida and Oklahoma) have narrower calling hours than the federal 08:00 to 21:00 window. This function doesn't apply them.
- **Stateless:** nothing is stored between calls, as you asked. The kit's shared-state functions are in the file but unused.
- **Appended kit:** the end of `bot.mjs` is the proactive-gate helper kit. The gate uses only its timezone and window functions.
