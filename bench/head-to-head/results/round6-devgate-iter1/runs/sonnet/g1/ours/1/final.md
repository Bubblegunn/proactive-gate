`bot.mjs` is written in the working directory, and all 12 inline checks passed. I ran them with the server clock set to `Pacific/Kiritimati` to confirm the server's time zone doesn't matter.

**Rules, in the order they are checked**

Reasons are `snake_case` codes, and each rule has its own.

| Order | Code | Applies to | Rule |
|---|---|---|---|
| 1 | `invalid_now`, `invalid_message`, `invalid_kind` | all | Bad input is held, never guessed. |
| 2 | `opted_out` | marketing | Any non-empty `optedOutAt` blocks, and it beats consent. |
| 3 | `no_marketing_consent` | marketing | `marketingConsent` must be exactly `true`. A missing value counts as off. This stands in for the prior express consent in 64.1200(a). |
| 4 | `invalid_time_zone` | marketing | A missing or unknown zone is held, never guessed. |
| 5 | `outside_calling_hours` | marketing | Allowed from 08:00 up to 20:59, recipient local time. 08:00 is included and 21:00 is excluded (64.1200(c)(1)). |

- **Transactional texts:** they are always allowed. Login codes and delivery updates the customer triggered are not telemarketing. A STOP reply opts the customer out of marketing, so it doesn't block them. Consent, opt-out and the time window don't apply to them.
- **Local time:** the window uses `Intl` with `to.timeZone`. The tests cover both sides of both window edges and the 2026-11-01 daylight-saving change in Chicago. 07:59 CST is blocked and 08:00 CST is allowed.

**Not enforced, because your request doesn't state them:**
- A STOP or brand-identification notice in the body. CTIA recommends one, so it is a recommendation, not a block. If counsel wants it required, it is one added check.
- The National Do-Not-Call registry (64.1200(c)(2)). The message has no data to check against.
- State quiet-hours laws that are stricter than 8am–9pm.
- The one-time STOP confirmation reply.
- A cap on how many marketing texts one customer gets.
- The FCC's 10-business-day limit for honoring a revocation. The function blocks immediately.

**State and idempotency:** the function is pure and keeps no state because your spec has no message id or storage location. If the same marketing text is retried at different times, the answer can change with the time window.
