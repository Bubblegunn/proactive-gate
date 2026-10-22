`bot.mjs` is written at `work/ours-g1-1/bot.mjs`. It exports `checkSms(message, now)`, is synchronous, has no dependencies, and reads only `now` and the customer's `timeZone`, so the server's zone doesn't matter. It sends nothing. The gate is stateless, so I wrote it inline rather than using the proactive-gate library.

**Self-check:** 24 cases pass under server zones UTC, Asia/Tokyo and America/Los_Angeles. They cover the 08:00 and 21:00 boundaries, a US DST change, a half-hour zone (Asia/Kolkata), opt-out, consent, and the invalid-input paths. The check script is in `/tmp/sms-selfcheck/check.mjs`. It isn't in the project.

**Rules and reason codes**

| Check | Blocks with | Applies to |
|---|---|---|
| Malformed `now`, message, kind, empty body, recipient, or phone (must be a US E.164 number) | `invalid_now`, `invalid_message`, `invalid_kind`, `empty_body`, `invalid_recipient`, `invalid_phone` | both |
| `optedOutAt` non-null (malformed values also block) | `opted_out` | both |
| `marketingConsent !== true` | `no_marketing_consent` | marketing |
| Body lacks "Reply STOP" / "Text STOP" | `missing_opt_out_instructions` | marketing |
| Invalid or non-region IANA zone | `invalid_time_zone` | marketing |
| Local time outside 08:00 to 21:00 (start included, end excluded) | `outside_marketing_hours` | marketing |

Transactional messages pass when they clear the opt-out and input checks. Allowed results return `reason: null`.

**Choices to confirm with your lawyers**

1. **STOP blocks transactional texts too.** Login codes to a customer who replied STOP are blocked. This matches CTIA's program-level opt-out and the FCC's revoke-all rule. I didn't verify that rule's current effective date, so please check it. If you want login codes to keep working after STOP, that's a one-line change, but I'd want the lawyers to sign off first.
2. **Transactional texts skip quiet hours.** They are customer-triggered, so a 3 a.m. login code goes out. Marketing is the only kind held to the 08:00–21:00 window.
3. **The 21:00 end is exclusive.** It follows the "after 9 p.m." wording of 47 CFR 64.1200(c)(1).
4. **Marketing bodies must contain "Reply STOP" or "Text STOP".** This is a CTIA opt-out instruction requirement. The check is a text match, so the copy must include that phrase.
5. **`marketingConsent` must mean written consent.** The rule requires prior express written consent. The sign-up box wording and its record-keeping are on your side, outside this function.
6. **The phone check is US-only.** Non-US numbers return `invalid_phone`.

**Not covered:** The function can't tell whether a transactional body contains promotional content. Your app has to keep marketing copy out of the transactional path. I also didn't confirm the CTIA-specific hour window against the current CTIA document; the 08:00–21:00 window is the TCPA telephone-solicitation window.

The reason codes are distinct by construction, since each refusal returns a different string. My check script's distinctness assertion compares a set with itself, so it proves nothing. Reading the code is what establishes that.
