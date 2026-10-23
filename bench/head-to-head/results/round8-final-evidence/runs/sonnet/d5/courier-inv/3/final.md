`bot.mjs` is written and the checks pass: I ran a script (`/tmp/bot-check.mjs`) that covers each rule, the 24-hour and 7-day boundaries, the argument-unchanged requirement, and that every candidate appears exactly once. Nothing is sent. I didn't run a real Node 22 install separately, only the Node on this machine.

**Rules and their identifiers**, checked in this order. The first one that matches is the one reported.

| Rule | What it holds |
|---|---|
| `unknown-category` | Any category other than `promo`, `reminder` or `critical`. |
| `promo-no-opt-in` | A promo when `promoOptIn` is not exactly `true`. This follows App Store guideline 4.5.4: no promotional push without explicit opt-in. |
| `quiet-hours` | A promo or reminder while the customer's local time is inside their quiet hours. |
| `quiet-hours-unreadable` | A promo or reminder when the quiet hours or time zone can't be read. |
| `dedupe-7d` | The same `dedupeKey` was sent within the last 7 days. |
| `duplicate-in-batch` | A lower-ranked candidate sharing a `dedupeKey` with a better one in the same batch. |
| `rate-limit-24h` | The 4th and later promo or reminder in a rolling 24 hours. |

**Behaviour you should know about**
- **Ordering:** `send` is sorted by priority, highest first. Ties go to `critical`, then to input order.
- **Critical messages:** they skip the opt-in, quiet-hours and rate-limit rules and don't count toward the 3-per-24-hours limit. The Courier guidance on security alerts says not to delay them for quiet hours.
- **Critical and dedupe:** critical messages still obey the 7-day `dedupeKey` rule. Your policy didn't exempt them, and it stops the same alert going out twice. If a repeat fraud alert must always go out, give each alert its own `dedupeKey` or tell me to exempt `critical`.
- **Quiet hours:** the window is read in the customer's time zone, so daylight saving is handled. The start is inclusive and the end is exclusive. A window like 22:00–07:00 crosses midnight. If start equals end, I treat it as no window.
- **Rolling windows:** a message sent exactly 24 hours ago, or exactly 7 days ago, no longer counts.
- **Bad data:** I chose to hold the message rather than send it when the quiet hours or time zone can't be read. An unparseable `sentAt` in `history` counts as just sent, so a bad record can only make the function send less. An invalid `now` throws a `TypeError`.

I didn't commit anything.
