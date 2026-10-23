`bot.mjs` is written and exports `createGate()`. My check script (outside the repo, in `/tmp/bot-check/check.mjs`) passes on Node. It sent nothing and never reads the clock.

**Rules**
- **Security alerts:** always allowed and never counted toward promo limits. They return `rule: ""` and an id. The Knock guide treats security alerts as send-every-time, and a login warning should not wait behind a promo cap.
- **`daily-cap`:** a 4th promo on the same local day is refused. The day is the customer's calendar date in their own `timeZone`, midnight to midnight, using the `Intl` API. This handles daylight-saving days, such as the 23-hour day on 2026-03-08 in Los Angeles.
- **`min-gap`:** a promo less than 2 hours from another allowed promo is refused. Exactly 2 hours is allowed. The check also works if `now` goes backwards.
- **Both rules broken:** `daily-cap` is reported.
- **`unknown-category`, `invalid-time-zone`, `invalid-time`:** refused for anything that isn't `"promo"` or `"security"`, a bad IANA name, or a bad `Date`. I added these three. Refusing is safer than guessing, and support can see why.
- **Security with a bad time zone or date:** still allowed, because it doesn't need either.

**State**
- **`request` records the send:** an allowed promo is stored at once, so two calls in a row can't both pass.
- **`cancel(id)`:** removes that send, so it stops counting toward the cap and the 2-hour gap. Calling it twice, or with an unknown or security id, does nothing.
- **Memory:** it keeps one entry per allowed promo and is never pruned. That is fine for one process. For very long uptimes you could drop entries older than about 2 days.

**What the check covered**
- Gap boundary at 1:59:59 vs 2:00:00, and the cap of 3.
- The reset at local midnight.
- The same instants counting differently in Berlin and Los Angeles.
- Users staying independent of each other.
- The DST day.
- `cancel` freeing a slot.
- Security alerts not being counted.
- Bad input.

I made no commits.
