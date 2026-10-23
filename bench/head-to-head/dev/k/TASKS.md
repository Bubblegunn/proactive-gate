# Development set k: five proactive-messaging tasks

Sources marked "from memory" were not looked up (no network). The tasks are not tuned against any tool.

## k1 - Promotional SMS time window (stateless, time zones, legal contact window)
Situation: a US retail app decides whether one promotional text may go out now; a refusal must carry the next allowed instant.
1. Window edges 07:59 / 08:00 / 20:59 / 21:01 at the recipient. Source: 47 CFR 64.1200(c)(1), no telephone solicitation before 8 a.m. or after 9 p.m. at the called party's location (from memory).
2. Recipient's zone, not the server's (checker sets TZ=Pacific/Auckland). Source: same rule, "at the called party's location".
3. Refusal carries next 08:00 local instant (same day, next day, month/year rollover). Source: prompt asks for earliest retry moment; engineering rationale.
4. Spring-forward day in New York. Source: engineering rationale (DST).
5. Fall-back day in New York including the repeated hour. Source: engineering rationale (DST).
6. Half-hour and 45-minute offsets (Kolkata, Kathmandu). Source: engineering rationale (IANA zones).
Validation: good 6/6; broken-a (whole-hour offsets) 5/6, fails 6; broken-b (next time = now + hours at today's offset) 4/6, fails 4, 5.

## k2 - Three pushes per day, several workers (stateful, shared state, redelivery, local day)
Situation: fitness app, several worker processes sharing STATE_DIR, at-least-once queue, limit of three pushes per member per day.
1. Cap of three, refusal with reason. Source: prompt limit plus engineering rationale (support needs reason).
2. Day ends at member's local midnight (not UTC, not rolling 24h). Source: engineering rationale (the member's own calendar day; the prompt hints, it does not say "local day").
3. 25-hour and 23-hour days on New York clock-change dates. Source: engineering rationale (DST).
4. Four processes at once never exceed three. Source: engineering rationale (atomic read-modify-write on shared state).
5. Redelivered messageId, even in another worker, not counted twice. Source: engineering rationale (at-least-once delivery; idempotency).
6. Count survives restart; members independent. Source: engineering rationale (prompt requires survival of restart).
Validation: good 6/6; broken-a (async read then write, no lock, no dedupe) 4/6, fails 4, 5; broken-b (rolling 24h window, locked, deduped) 4/6, fails 2, 3.

## k3 - SMS and email consent withdrawal (stateful, shared state, STOP keywords, restart)
Situation: tracks withdrawals only; inbound SMS and email replies are handled by any worker, possibly out of order.
1. STOP-family keywords in any case, with spaces, plus a confirmation reply. Source: CTIA Messaging Principles and Best Practices, opt-out keywords and confirmation (from memory); Twilio default keyword list (from memory).
2. Ordinary sentences containing stop/end/start/quit do not opt out. Source: CTIA (keyword is the message, not a substring); engineering rationale.
3. Per channel and per person. Source: CAN-SPAM 15 U.S.C. 7704(a)(4) (email opt-out) and TCPA/CTIA (SMS program opt-out) are separate programs (from memory); engineering rationale.
4. Opt-out visible to a different worker process after restart. Source: engineering rationale; prompt requires survival of restart.
5. START/UNSTOP resubscribe; HELP replies and changes nothing. Source: CTIA HELP and START keywords (from memory).
6. Out-of-order handling: latest sent time wins. Source: engineering rationale (webhooks arrive out of order; a late START must not undo a later STOP).
Validation: good 6/6; broken-a (opt-out per person, last arrival wins) 3/6, fails 3, 4, 6; broken-b (substring match, no HELP) 4/6, fails 2, 5.

## k4 - Push dropped, inbox item kept (single process, stateful in memory)
Situation: scheduler asks decide() per message; promo, reminder, security categories; quiet hours in the person's zone.
1. Quiet hours crossing midnight and not crossing midnight. Source: engineering rationale; Apple/Google notification guidance (respect user settings), from memory.
2. Start quiet, end not quiet; no quiet hours means none. Source: engineering rationale.
3. Quiet hours follow wall clock through Berlin and New York clock changes. Source: engineering rationale.
4. Every dropped push still leaves the inbox item; reasons differ per cause. Source: prompt says every message also appears in the inbox; engineering rationale (support must tell which rule fired).
5. Security alerts bypass quiet hours but not push off / no token; promo held. Source: engineering rationale (time-critical account alerts).
6. A pushed message is never pushed twice; a held message goes out on a later retry once. Source: prompt retry statement; Apple/Google guidance on repeated notifications (from memory).
Validation: good 6/6; broken-a (inbox item only when push sent) 3/6, fails 4, 5, 6; broken-b (standard-time offset, ids remembered even when dropped) 3/6, fails 2, 3, 6.

## k5 - Weekly digest email (stateless, under-specified: do not invent blocks)
Situation: decide whether a weekly digest email may go to one person; the prompt gives fields and a vague "stay on the right side of CAN-SPAM and Gmail/Yahoo bulk-sender rules".
1. Unsubscribed or complaining person gets nothing. Source: CAN-SPAM 15 U.S.C. 7704(a)(4); Google/Yahoo sender requirements (from memory).
2. Hard bounce suppressed. Source: mail provider practice, engineering rationale.
3. Soft bounce alone allowed (must not be invented as a block). Source: engineering rationale; prompt defines soft as temporary.
4. Digest an hour ago blocks, eight days ago allowed. Source: prompt ("weekly"); the 6-7 day boundary is not tested.
5. No invented time-of-day or weekend block. Source: CAN-SPAM has no contact window (the 8-to-9 rule is telephone only).
6. Missing/null optional fields do not block or throw. Source: prompt states old accounts lack fields.
Validation: good 6/6; broken-a (invented 8-21 window, throws on null zone) 4/6, fails 5, 6; broken-b (any bounce blocks, weekend block) 4/6, fails 3, 5.

## How to run
`node out/checkers/kN.mjs out/ref/kN-good` (and `-broken-a`, `-broken-b`). The files `out/ref/tzh.txt` and `out/ref/lock.txt` are source snippets used to build the reference solutions.
