`bot.mjs` is written and passes my 32 checks. They covered both sides of the 8:00 and 21:00 boundaries in summer and winter, Tokyo and Kolkata, bad time zones and bad input, and calls that pass `null`, `undefined`, or an object whose property getter throws. It sends nothing and never reads the clock. The checks were a throwaway script in `/tmp/t`, so there is no test file in your repo.

**Rules.** The first match holds the text, in this order:

| `rule` | When it holds the text |
|---|---|
| `invalid-user` | `user` or `user.sms` is missing or not an object |
| `invalid-message` | `kind` isn't `marketing` or `transactional`, or the text is blank |
| `opted-out` | `optedOutAt` has any value other than `null` or `undefined`; this applies to transactional texts too |
| `no-consent` | marketing only: `optedIn` isn't exactly `true` |
| `invalid-time` | marketing only: `now` isn't a valid Date |
| `unknown-local-time` | marketing only: `timeZone` is missing, invalid, or not a real location |
| `quiet-hours` | marketing only: local time is before 08:00 or at/after 21:00 |

Anything unexpected also holds the text, with `invalid-input`. Transactional texts skip everything after `opted-out`.

**Decisions to confirm:**
- **STOP blocks transactional texts too.** My reading of the FCC's revocation rule and CTIA is that STOP ends all texts from you. So a login code to someone who texted STOP is held. If your lawyer says otherwise, remove the `opted-out` check for the transactional kind.
- **Transactional texts don't need `optedIn`.** They go out when the customer hasn't opted out, at any hour. Order updates fall under the consent given when the number was provided.
- **`"UTC"`, `"Etc/*"`, offsets and unknown names count as no time zone.** Those are usually defaults, not a customer's location, so marketing texts to them are held as `unknown-local-time`. Fixing the profile data releases them.
- **An unparseable `optedOutAt` is treated as opted out.** The failure to avoid is texting someone who said STOP.

**What it can't catch:**
- A valid but wrong time zone, such as a Tokyo customer saved as `America/Chicago`.
- State rules stricter than the FCC's, such as Florida and Maryland ending at 8 p.m.
- India's 9 a.m. start for promotional texts; the 8:00 to 21:00 window is applied everywhere.
- Marketing wording inside a text labelled transactional.
- Missing opt-out wording like "Reply STOP". I left that check out because the FCC rule doesn't require it in every text, but I can add it if you want it.
