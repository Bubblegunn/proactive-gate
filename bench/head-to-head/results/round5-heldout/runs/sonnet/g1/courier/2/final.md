`bot.mjs` is written and checked. It exports `checkSms(message, now)` with no dependencies. I also added `bot.test.mjs`, which has 6 test groups. They all pass under `TZ=UTC`, `Asia/Tokyo` and `America/Los_Angeles`, so the server's time zone does not change the result. I ran them on Node 24 (the only version installed here), not Node 22. Nothing is sent.

**Rules, in the order they are checked** (the first one that fails gives the reason):

| Code | Applies to | Rule |
|---|---|---|
| `invalid_input`, `invalid_kind`, `invalid_phone_number`, `empty_body` | both | Input we can't read is blocked. The phone must be a valid +1 number (+1, then 10 digits, area code and exchange not starting with 0 or 1). |
| `opted_out` | marketing | Any non-null `optedOutAt` blocks, even if the date is unparseable or in the future. This overrides consent, because a STOP revokes consent (47 CFR 64.1200(a)(10), CTIA). |
| `no_marketing_consent` | marketing | Marketing needs prior express written consent (64.1200(a)(2)). Only the boolean `true` counts, so the string `"true"` fails. |
| `invalid_time_zone` | marketing | If the zone is missing or unknown, we can't tell the local time, so nothing goes out. |
| `outside_permitted_hours` | marketing | No marketing before 8:00 a.m. or after 9:00 p.m. at the customer's location (64.1200(c)(1)). The allowed window is 08:00:00 to 20:59:59 local time, computed from `to.timeZone` and `now`. |

Transactional texts pass once the input checks do. They are one-time replies to something the customer just did, and they carry no advertising. That is how the FCC treats them, so the consent, opt-out and hours rules don't apply.

**What your lawyers should know:**
- **STOP and transactional texts:** I let transactional texts through after a STOP, so a login code the customer asks for still arrives. This is my reading of the FCC rules, and I'm not certain of it. Your lawyers should confirm it.
- **No content check:** The function doesn't read the body. Nothing checks that transactional texts are free of promotions or that marketing texts name the sender and say "Reply STOP". If you want that enforced, it needs a new rule and code.
- **Time zone is a proxy:** It is the customer's home zone. A customer who is travelling is judged by home time.
- **State laws:** Some states have stricter hours, for example 8 a.m. to 8 p.m. in Florida, Maryland and Oklahoma. I applied only the federal window.
- **No re-consent:** There is no way to represent a customer who opted back in after a STOP, so the function blocks them until `optedOutAt` is cleared.
