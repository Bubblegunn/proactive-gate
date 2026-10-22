I wrote `bot.mjs` in the work directory and it passes 27 of 27 checks under four server time zones (UTC, Tokyo, Los Angeles, Istanbul). Nothing was sent and nothing was committed.

**Behavior**

- **Transactional** texts are allowed unless the input is malformed. Consent, STOP and time of day don't apply to them.
- **Marketing** texts are checked in this order, and the first failure gives the reason code:
  1. `opted_out`: `optedOutAt` is set.
  2. `no_marketing_consent`: `marketingConsent` is not exactly `true`.
  3. `missing_opt_out_language`: the body has no word "STOP" (case-insensitive).
  4. `outside_marketing_hours`: local hour in the customer's zone is before 08:00 or 21:00 or later. 08:00 is allowed and 21:00 is blocked.
- **Malformed input** fails closed with its own code: `invalid_message`, `invalid_now`, `empty_body`, `invalid_recipient`, `invalid_phone` (must be a US `+1` NANP number), `invalid_opt_out_record` (not null and not a parseable date), `invalid_time_zone` (missing or unknown IANA zone).
- Local time comes from `Intl.DateTimeFormat` with the customer's zone, so the server's zone is never read.

**Choices you should check with your lawyers**

- I treated the STOP rule as applying to marketing only. A transactional text after STOP is still allowed. Some readings of the FCC revocation rules, and some carrier and CTIA readings, would also block transactional texts. If they say so, it's a one-line change.
- `invalid_opt_out_record` also blocks transactional texts. I chose that on purpose: when the opt-out state is unknown, the function refuses.
- The time window uses the profile's home zone, not the customer's actual location. The TCPA rule is about the called party's location, so this is a proxy.
- The "STOP in every marketing body" check is my reading of CTIA. It is not a statute.
- I wrote the rule citations from memory and did not check the current text of 47 CFR 64.1200 or the CTIA guidelines. Please have counsel verify them.

**Not covered**

- Frequency caps, the national Do-Not-Call registry, state-level rules, and sender identification in the message body. None of these are in the input.
- The `now` value is trusted. The function does not check whether it is real time.

The environment has Node v24.13. I used only standard features, so it should also run on Node 22, but I have not run it on 22.
