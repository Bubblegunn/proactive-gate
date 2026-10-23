`bot.mjs` exports `planSends({ user, candidates, history, now })`. I also wrote `bot.test.mjs`, and all 10 tests pass with `node --test bot.test.mjs`. The function is pure: it doesn't read the clock or any file, and it doesn't change its arguments. It sends nothing.

**Rules, checked in this order (the first one that fails becomes the `rule` in `dropped`):**

| Rule id | Holds | Why |
|---|---|---|
| `invalid-category` | any unknown category | Can't tell what it is. |
| `promo-no-opt-in` | promos when `promoOptIn` isn't `true` | Apple's guideline 4.5.4 allows promotional push only with explicit opt-in. |
| `invalid-quiet-hours` / `invalid-time-zone` | reminders and promos when `quietHours` is malformed or `timeZone` isn't a valid IANA name | Holds the message rather than risk sending it inside someone's quiet hours. |
| `quiet-hours` | reminders and promos inside the window | The window is read in the customer's local time. It can wrap midnight, start is inclusive, end is exclusive, and `start == end` means no quiet time. |
| `dedupe-7d` | same `dedupeKey` sent within the last 7 days | A message sent exactly 7 days ago is allowed. |
| `dedupe-in-batch` | a second candidate with a `dedupeKey` already chosen in this run | The higher-priority one wins. |
| `cap-24h` | reminders and promos beyond 3 in a rolling 24 hours | History counts toward the 3, then the highest priorities fill the remaining slots. A message sent exactly 24 hours ago no longer counts. |

`critical` messages skip opt-in, quiet hours and the cap, because they are fraud and security alerts. They always sort first in `send`, and they don't count toward the 3.

**Decisions to confirm:**
- **Dedupe on critical:** I applied the 7-day dedupe to critical too, since you gave no exception. If a repeat fraud alert reuses a key, it will be held, so give distinct events distinct keys. I can exempt critical if you prefer.
- **Unparseable history:** a history entry with an unparseable `sentAt` is treated as just sent, so it blocks rather than allows.
- **Promo opt-in scope:** the opt-in check covers promos in-app as well as push, since candidates carry no channel.
- **Invalid `now`:** an invalid `now` throws a `TypeError`.

I also export a `RULES` object with the rule ids.
