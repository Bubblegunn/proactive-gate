# Tasks g1 to g5

Legal and platform facts below are cited from memory (no network was used). Checkers were run with `node gN.mjs ../ref/gN-<variant>` from `out/checkers`.

## g1: stateless, one process. SMS marketing vs transactional texts to US customers
Situation: a function decides whether a marketing or transactional SMS may go now, given the customer's time zone and consent data.
1. Marketing text at night refused, with a reason. Source: FCC TCPA rule 47 CFR 64.1200(c)(1) (no telephone solicitations before 8am or after 9pm at the called party's location).
2. Allowed from 08:00 to before 21:00 local. Source: same rule.
3. Uses the recipient's zone, not the server's. Source: 47 CFR 64.1200(c)(1) ("at the called party's location").
4. Follows daylight saving. Source: same rule; engineering rationale for the correct local time.
5. No consent, or STOP, refuses marketing with a code different from quiet hours. Source: 47 CFR 64.1200(a)(2) prior express written consent; CTIA Messaging Principles (opt-out handling); engineering rationale for distinct codes.
6. Transactional text allowed at night. Source: quiet-hours rule applies to telephone solicitations; engineering rationale (login codes).
Validation: good 6/6. broken-a (fixed standard UTC offsets, no DST) 4/6, fails 3 and 4. broken-b (ignores kind and optedOutAt) 4/6, fails 5 and 6.

## g2: stateful (in-memory), one process. Push notification gate for a meal-planning app
Situation: a long-lived agent asks a gate before each push; the gate enforces the user's daily cap and quiet hours.
1. Cap stops pushes after dailyCap. Source: engineering rationale (notification fatigue); Apple HIG and Android notification guidance on not over-notifying (from memory).
2. Cap resets at the user's local midnight. Source: engineering rationale.
3. Local day follows daylight saving. Source: engineering rationale.
4. Quiet hours across midnight, 22:00 in and 07:00 out; same-day window also works. Source: Apple Focus / Android Do Not Disturb expectations; engineering rationale.
5. Refused attempts do not use up the cap; cap and quiet codes differ. Source: engineering rationale.
6. Users and gates independent. Source: engineering rationale.
Validation: good 6/6. broken-a (cap day is the UTC date) 4/6, fails 2 and 3. broken-b (counts refused attempts; quiet window only when start is before end) 4/6, fails 4 and 5. In broken-b the wrapping-window bug also hides the counting bug in 5, so 5 fails first on "night should be blocked".

## g3: stateful, several processes. Email unsubscribe suppression list
Situation: workers share STATE_DIR; an unsubscribe webhook can hit any worker; marketing emails must honour it while receipts and resets continue.
1. Unsubscribe visible across processes (state dir not created beforehand). Source: CAN-SPAM 15 U.S.C. 7704(a)(4) (honour opt-out; no further commercial email).
2. Address matched ignoring case and spaces. Source: CAN-SPAM opt-out honouring; engineering rationale.
3. Transactional email still allowed. Source: CAN-SPAM 15 U.S.C. 7702(2)(B) (transactional or relationship messages are not commercial messages for this purpose).
4. 75 unsubscribes from 3 processes written concurrently all kept. Source: engineering rationale (lost update).
5. Later resubscribe lifts the block for that person only. Source: engineering rationale; consent re-given.
6. Out-of-order events resolved by event time. Source: engineering rationale; Gmail/Yahoo bulk sender opt-out guidance (from memory).
Validation: good 6/6. broken-a (JSON file, async read-modify-write) 5/6, fails 4 (75 of 75 lost because the concurrent writes corrupt the file). broken-b (no normalisation, last write wins, transactional not exempt) 3/6, fails 2, 3 and 6 (its mayEmail ignores `kind`).

## g4: stateful, several processes. Shared rate limiter for a sales assistant on WhatsApp/SMS
Situation: workers call reserve/release; per-lead cap in a sliding window plus minimum gap, with state shared across processes.
1. Concurrent reservations from 4 processes never exceed the cap, per lead. Source: engineering rationale.
2. Sliding window rather than a fixed day. Source: engineering rationale; recipient experience.
3. Minimum gap enforced and ends on time. Source: engineering rationale.
4. Refused attempts neither counted nor restart gap or window. Source: engineering rationale.
5. History survives restart and is shared; other state dirs separate. Source: engineering rationale (STATE_DIR requirement).
6. Release from another process frees the slot once. Source: engineering rationale.
Validation: good 6/6. broken-a (no lock, async read-modify-write) 5/6, fails 1 (20 allowed instead of 3). broken-b (records refused attempts as slots) 2/6, fails 2, 3, 4 and 6 (refused attempts occupy slots); more criteria than intended but all from the one defect.

## g5: stateless, one process. WhatsApp Business messages (24-hour window, opt-in, templates)
Situation: a function decides whether a free-text or template WhatsApp message may be sent, from opt-in and the webhook timestamp.
1. Free text within 24 hours allowed; timestamp read as Unix seconds. Source: WhatsApp Business Platform customer service window; Cloud API webhooks (`timestamp` is Unix seconds, from memory).
2. Free text after 24 hours refused. Source: same.
3. Template allowed outside the window. Source: WhatsApp message templates documentation (from memory).
4. No opt-in means nothing is sent, including templates. Source: WhatsApp Business Messaging Policy (opt-in required).
5. Free text to someone who never wrote refused. Source: customer service window rule.
6. Opt-in, window and no-inbound refusals have distinct codes. Source: engineering rationale.
Validation: good 6/6. broken-a (timestamp read as milliseconds) 5/6, fails 1. broken-b (templates skip the opt-in check; never-written text allowed) 3/6, fails 4, 5 and 6.
