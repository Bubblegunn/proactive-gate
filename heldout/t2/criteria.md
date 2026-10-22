# T2 criteria (run: node checker.mjs <project-dir>)

Rules used: FCC/CTIA style opt-out keywords; the FCC revocation rule means STOP must be honoured immediately here (the task is stricter than the allowed grace period). Quiet hours in the recipient zone with DST.

1. C1 Exactly-once budget under 50 concurrent sends: cap 3 gives 3 delivered, 47 blocked with rolling_24h_cap, usage 3; one id submitted 50 times is delivered once; two dispatcher instances on one stateDir (25 each, and the same id on both) still deliver exactly 3 and at most once.
2. C2 Crash between send and record: after a throw that happened after delivery, a new dispatcher on the same stateDir counts the message once, blocks a different message by the cap, lets the retry through without a second delivery, uses a stable non-empty idempotency key per message (different keys for different messages), and after a failure before delivery the retry delivers exactly once and counts once.
3. C3 STOP and START: keyword table (including negatives such as "please do not stop sending", "endless"), sms only, survives restart, push unaffected, START restores; with 40 concurrent sms and a STOP landing mid flight, zero vendor calls begin after handleInbound resolved.
4. C4 Quiet hours in the recipient zone across both DST changes (Los Angeles), blocked messages never touch the vendor and do not count, critical bypass, reason order [no_consent, quiet_hours, rolling_24h_cap] with details, usage window edges at exactly 24h and exactly 7d.
5. C5 No global serialization: 50 recipients with a 40 ms vendor call finish in under 1000 ms, all delivered once, usage 1 each.

Validation done by the author: ref/correct passes 5 of 5 (three runs). broken-record-after and broken-random-key fail C2; broken-no-lock fails C1 and C3; broken-stop-race fails C3.
