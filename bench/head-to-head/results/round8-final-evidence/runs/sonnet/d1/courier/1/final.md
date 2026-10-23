`bot.mjs` is written and exports `checkSend`. It sends nothing and never reads the clock. I ran it against 26 cases (all pass) plus six malformed inputs. One of those, `null`, made it throw. I fixed that, and now none of them throw. The test script is in `/tmp/gt/t.mjs`, outside the project.

**Rules, checked in this order.** Each hold has its own identifier:

| `rule` | Holds the text when |
|---|---|
| `invalid-user` | `user` is missing or not an object. |
| `opted-out` | `optedOutAt` has any value. This holds transactional texts too, so a login code is also held after STOP. |
| `invalid-message` | The text is missing, not a string, or blank. |
| `no-consent` | The text is marketing and `optedIn` is not exactly `true`. |
| `missing-opt-out` | The text is marketing and has no "Reply STOP to opt out" style wording. |
| `invalid-time` | The text is marketing and `now` is not a valid Date. |
| `unknown-time-zone` | The text is marketing and `timeZone` is missing or not a real zone. |
| `quiet-hours` | The text is marketing and the customer's local time is before 08:00 or at/after 21:00. |

**Calls I made, which you may want to change:**
- **Marketing definition:** any `kind` other than exactly `"transactional"` is treated as marketing, as you defined it.
- **Promotional wording:** a "transactional" text that contains words like "% off", "sale" or "use code" is also treated as marketing. The FCC treats a shipping notice with a coupon in it as a sales text. The word list is rough, so it may miss some promotions and catch some plain notices.
- **Transactional texts:** they skip the `optedIn`, time-zone and quiet-hours checks. A login code at 3am goes out even if the time zone is missing. They are only held for `opted-out`, blank text or a missing user.
- **Opt-out wording:** I added the `missing-opt-out` check from the CTIA guidance. I can't check for your business name in the text, so that is not covered.
- **Time-zone fallback:** when `timeZone` is missing or invalid, marketing is held rather than guessed. No local window works for the US, India and Japan at once. Customers with no time zone get no marketing until their profile is fixed. A valid but wrong zone can't be detected.
- **Opt-out vs. opt-in:** a set `optedOutAt` wins even if `optedIn` is `true`, since the function can't tell which came later. A customer who re-subscribes needs `optedOutAt` cleared on your side.

**Not covered:**
- The National Do Not Call list, because it needs outside data.
- Stricter state quiet hours, such as Florida's 8am–8pm. Say if you want the window narrowed to 8am–8pm.
