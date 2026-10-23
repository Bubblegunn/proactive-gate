`bot.mjs` is written and exports `createGate()`. My test script passed all its checks. It's at `/tmp/gate-test/test.mjs`, outside the repo.

**Promos**
- **Daily cap:** a promo is allowed if the customer has fewer than 3 promos on the same local calendar day. Each earlier promo is placed on its day in the time zone passed with the current request. A customer who changes time zone is judged by the new one.
- **Gap:** a promo is denied if any earlier promo to that customer is less than 2 hours away. Exactly 2 hours is allowed.
- **Which rule is reported:** if both rules would block a promo, `daily-cap` is reported rather than `min-gap`.

**Security alerts**
- They are always allowed and get an id. They don't count toward the promo limits.

**Cancel**
- `cancel(id)` removes that promo from the customer's counts. This frees both the daily slot and the gap.
- It does nothing for unknown ids, repeated ids, or security ids.

**Denial rule identifiers**

| `rule` | Meaning |
|---|---|
| `daily-cap` | The customer already has 3 promos that local day. |
| `min-gap` | Another promo was sent less than 2 hours before or after. |
| `invalid-time-zone` | The time zone name isn't a valid IANA name. |
| `invalid-time` | `now` isn't a valid Date. |
| `unknown-category` | The category isn't "promo" or "security". |

The last three cases weren't in your spec. I chose to deny rather than throw, so one bad input can't crash the service.

**What the test covered**
- **Boundaries:** local midnight in Los Angeles, and exactly 2 hours between promos.
- **Isolation:** different customers don't affect each other.
- **Security:** it isn't limited.
- **Cancel:** it frees a slot, and repeated or unknown ids are ignored.
- **Daylight saving:** Berlin's 25-hour day on 25 Oct 2026, and the rollover at local midnight afterwards.
- **Invalid input:** a bad time zone name is denied.

The gate keeps its counts in memory and keeps every promo record until it is cancelled, so memory grows slowly over time. At your scale that is probably fine. If it becomes a concern, old records could be pruned.

Nothing is sent and the system clock is never read.
