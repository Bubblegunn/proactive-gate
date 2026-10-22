`bot.mjs` is written at `work/ours-g1-2/bot.mjs`. It exports `checkSms(message, now)`, returns `{ allowed, reason }`, and sends nothing. All 14 checks pass with the server time zone set to UTC, Asia/Tokyo and America/Los_Angeles.

**Rules, in the order they are checked:**

| Kind | Check | Reason code when blocked |
|---|---|---|
| any | `now` is not a valid Date | throws `TypeError` (a programmer error, not a refusal) |
| neither marketing nor transactional | — | `unknown_message_kind` |
| transactional | — | allowed. Customer-triggered, so consent, opt-out and hours do not apply |
| marketing | `marketingConsent !== true` | `marketing_no_consent` |
| marketing | `optedOutAt` is a valid ISO string | `opted_out` |
| marketing | `optedOutAt` missing or malformed | `opt_out_status_unknown` |
| marketing | `timeZone` missing or not a valid IANA zone | `invalid_timezone` |
| marketing | local time outside 08:00 to 21:00 | `outside_marketing_hours` |

**Choices I made:**
- **Quiet hours:** 08:00 included, 21:00 excluded, in the customer's own zone. This is the TCPA telemarketing window in 47 CFR 64.1200(c), which you named. The local time comes from `Intl` with `timeZone`, so the server's zone never matters.
- **Consent:** only `marketingConsent === true` passes. False, absent or any other value blocks.
- **Opt-out:** a `null` value means never opted out. A valid timestamp means STOP was received. A missing field is held as unknown.
- **Transactional and STOP:** I let transactional texts through even after `optedOutAt` is set. The reasoning is that the customer triggered them and they are not promotions. This is the decision your lawyers most need to check. CTIA's principles say a STOP should end the program, so if your lawyers read the program as one thing, transactional texts after STOP would need to be blocked too.
- **Transactional and zone:** a bad zone does not block transactional texts, because they have no time window.

**Not enforced:** the body of the message is not checked. CTIA recommends that marketing texts identify the sender and say how to opt out ("Reply STOP"). That is a recommendation, not a rule the TCPA text you named requires, so I did not add a block for it.

**Things that differ from your spec or are not covered:**
- Your spec says `reason` is a short code. The skill I follow asks for a plain sentence with a retry time. I kept your spec: codes only, and no retry time is returned.
- No day-of-week restriction. Some states have rules beyond the federal ones, and your spec named only the federal ones.
- The function is stateless. It does not claim or dedupe sends. Redelivery and the send-side claim have to live in the sender that calls it.

**Self-check:** I ran it inline, not as a saved test file. It covered the window edges (07:59 blocked, 08:00 allowed, 20:59 allowed, 21:00 blocked), each refusal code, the transactional bypass, and a bad `now`. The temporary check script has been deleted.
