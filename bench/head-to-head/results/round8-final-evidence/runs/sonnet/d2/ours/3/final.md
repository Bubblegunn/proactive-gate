`bot.mjs` is written and exports `createGate()`. I checked it with a throwaway script (`/tmp/t.mjs`, not part of the deliverable), and every check passed. Nothing is sent, and it never reads the system clock.

**What the gate does**
- **Promos:**
  - Daily cap: at most 3 per customer per local day, midnight to midnight in the `timeZone` passed with the request.
  - Spacing: at least 2 hours between promos. Exactly 2 hours apart is allowed.
- **Security alerts:** always allowed. They don't count toward the cap and aren't affected by the spacing rule.
- **Memory:** state is in memory only, as you said was fine, so a restart clears all the counts.
- **Refusals:** each one returns `{ allowed: false, rule, id: null }`, with a fixed identifier per rule:

| Rule identifier | When it applies |
|---|---|
| `daily-cap` | The customer already has 3 promos on that local day. |
| `min-gap` | The last promo was less than 2 hours before or after this one. |
| `invalid-timezone` | The zone is missing or not a real IANA name. |
| `invalid-time` | `now` is not a valid Date. |
| `unknown-category` | The category is neither "promo" nor "security". |

- **Cancel:** `cancel(id)` removes that promo, so it stops counting toward the cap and spacing. An unknown id does nothing.
- **Allowed sends:** the `id` is unique for each one.

**What the check covered**
- The first promo is allowed with an empty `rule` and an `id`.
- A promo under 2 hours after another is refused as `min-gap`, and one exactly 2 hours after is allowed.
- The 4th promo of a Los Angeles day is refused as `daily-cap`, then allowed again after Los Angeles midnight.
- A security alert goes through even when the cap is reached.
- A cancelled promo frees its slot, including the spacing window.
- In Europe/Berlin, the day rolls over at local midnight.
- A bad zone is refused as `invalid-timezone`.

**Choices you didn't specify**
- **Order of checks:** if a promo breaks both rules, `daily-cap` is reported, not `min-gap`.
- **Security alerts:** they go out even with an invalid time zone.
- **Zone changes:** if a customer's zone changes mid-day, earlier promos are re-counted against the zone on the new request.
- **Skill kit not used:** I didn't use the proactive-gate kit's shared-state helpers, because you said in-memory is enough for one Node process.
- **Consent and opt-out:** the gate checks neither, since your request lists no such data. Add that check before the gate if you need it.
