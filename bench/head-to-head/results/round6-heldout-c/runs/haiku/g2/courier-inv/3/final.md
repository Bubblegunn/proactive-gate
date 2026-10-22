`bot.mjs` is written and all 31 checks pass. Node 22 was not tested: the machine has Node v24.13.0, and I used only standard `Intl` and `Date` APIs.

**Decision for you: how the module knows a customer is waiting for a courier.** The candidate shape you specified has no field for that, so I added an optional `courierWaiting: true` flag. A transactional push with that flag ignores quiet hours. Without the flag, transactional pushes respect quiet hours. The caller that sends the courier notification must set the flag, or it will be held during the customer's quiet hours. If you would rather have a different field name or signal, tell me and I'll change it.

**Behavior**
- **Quiet hours:** Checked first, in the customer's own IANA timezone. The start is inclusive and the end is exclusive. Windows past midnight work. `start === end` means no quiet hours. A quiet-blocked push returns `rule: "quiet-hours"` and does not count toward the cap.
- **Daily cap:** 3 marketing pushes per customer local calendar day, checked after quiet hours. The 4th returns `rule: "daily-cap"`. The day key is the customer's local date, not the UTC date.
- **Transactional:** Never subject to the cap.
- **Return value:** `{ send, rule }`. When `send` is true, the count is recorded and `rule` is `null`.
- **Invalid input:** Throws a `TypeError` for a bad `HH:MM` value, category, `userId` or `now`. Throws a `RangeError` for an unknown timezone.
- **State:** One `Map` keyed by `userId`, holding the current local day and count. Each user's entry holds only the current day, so memory is bounded by the number of users. `decide` is synchronous, so check-and-increment cannot interleave within one process.

**Verification:** The checks are in `/tmp/bot-check/check.mjs`, outside the work directory. They cover the cap across the customer's local midnight, the UTC-vs-local day boundary, quiet-hours edges (22:00 inclusive, 07:30 exclusive), per-customer timezones, the courier exemption, and the input errors. Nothing was sent.

I did not call any Courier API. This gate runs in your app before the push is handed to the provider, so the Courier scheduling and throttling features don't apply here.
