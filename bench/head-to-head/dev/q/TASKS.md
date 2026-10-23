# Benchmark tasks q1 to q5

User problem: "My AI agent messages people at night and past their daily limit, and I cannot tell which rule should have stopped it."
Sources marked "memory" are from my memory, not checked against the documents (no network was used). No task was tuned against any tool.

## q1 - stateless, SMS: send window per recipient zone
Situation: a pharmacy refill-reminder service needs `checkSmsWindow(customer, now)` that decides, from consent and the customer's IANA zone, whether a text may go now and when it may next go.
1. Allowed mid-day in several zones, reason ok, no next time. Source: engineering rationale (return contract in prompt).
2. Window edges 07:59 / 08:00 / 20:59 / 21:01 / 03:00. Source: TCPA, 47 CFR 64.1200(c)(1) (not before 8 a.m. or after 9 p.m. at the called party's location) (memory).
3. Recipient zone decides, including Asia/Kolkata half-hour offset. Source: same rule, "called party's location".
4. Both daylight saving changes in New York. Source: same rule; engineering rationale.
5. nextAllowedAt is exactly the next 08:00 local, over DST changes and in Sydney. Source: engineering rationale.
6. No consent, missing or garbage zone: blocked, no throw, null next time, three distinct reasons. Source: TCPA consent requirement for promotional texts (47 CFR 64.1200(a)(2)) (memory); engineering rationale (fail closed, explainable).
Validation: good 6/6; broken-a (uses UTC clock) 1/6, fails 2-6; broken-b (right window, naive next-time arithmetic, bad zone treated as UTC) 4/6, fails 5 and 6.

## q2 - stateful, single process, push: daily marketing cap, permission, night
Situation: a fitness app's AI coach asks `decidePush(msg, now)` before each push; marketing is capped at 3 per local day, needs opt-in, and must not buzz at night; transactional goes through.
1. At most 3 marketing pushes a day, per user. Source: product rule in prompt.
2. Transactional never blocked and does not use quota (also at night, at cap, without opt-in). Source: Apple App Store Review Guideline 4.5.4 and Google Play notification policy distinguish promotional pushes from others (memory); engineering rationale.
3. The day is the user's local calendar day (not UTC day, not rolling 24 h). Source: engineering rationale; "per day" with a supplied time zone.
4. No opt-in: blocked, and refused tries use no quota. Source: App Store Guideline 4.5.4, Google Play policy (memory).
5. No marketing at night in the user's zone (02:00-05:00 tested); refused night tries use no quota. Source: engineering rationale (stated user complaint); mirrors TCPA-style quiet hours (memory).
6. One distinct non-empty reason per cause, ok when allowed. Source: engineering rationale (support needs to see which rule stopped a push).
Validation: good 6/6; broken-a (cap counted per UTC day) 5/6, fails 3; broken-b (every attempt counts, transactional counts, generic reason) 2/6, fails 2, 4, 5, 6.

## q3 - stateful, several processes, email: 2 marketing mails per rolling 24 h, unsubscribe
Situation: queue workers on one machine share STATE_DIR; `tryReserveEmail` must limit marketing mail to 2 per user in 24 hours atomically and `recordUnsubscribe` must stop marketing mail everywhere.
1. Eight concurrent calls in one process allow exactly 2. Source: engineering rationale (check-and-reserve atomicity).
2. State shared between processes and kept over a restart. Source: prompt requirement; engineering rationale.
3. Four racing processes, two users: exactly 2 each. Source: engineering rationale.
4. Unsubscribe is seen by other processes, is permanent, does not block transactional mail or other users. Source: CAN-SPAM Act 15 U.S.C. 7704(a)(4) (opt-out must be honoured; transactional messages are treated differently, 7702(2)(B)) (memory); Gmail/Yahoo bulk-sender rules of 2024 (one-click unsubscribe) (memory).
5. Rolling 24 h window with one slot freeing at a time; refused tries not recorded. Source: product rule in prompt.
6. Odd ids (a/b, ../escape, A vs a, 300 characters, non-ASCII, "con", "..") are independent users, no errors, nothing written outside STATE_DIR. Source: engineering rationale (path safety, case-insensitive file systems).
Validation: good 6/6; broken-a (no locking) 4/6, fails 1 and 3; broken-b (fixed UTC-day window, raw id as file name) 4/6, fails 5 and 6.

## q4 - stateful, several processes, SMS: STOP / START / HELP handling
Situation: a salon-chain SMS service has senders and webhook receivers sharing STATE_DIR; `handleInbound` processes customer replies and `canText` guards each outgoing text.
1. STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT in any case/whitespace opt out, a reply is returned, texts are blocked. Source: CTIA Messaging Principles and Best Practices (memory); FCC revocation rule 47 CFR 64.1200(a)(10) (memory).
2. Sentences that only contain a stop word do not opt out. Source: engineering rationale (prompt says mistakes in either direction cost money or customers).
3. Opt-out visible to other and later processes. Source: prompt requirement; TCPA.
4. Seven formats of one NANP number are one person; neighbour number and other area code unaffected. Source: engineering rationale (phone table comes from a sign-up form).
5. START re-subscribes, a second STOP stops again, HELP changes nothing. Source: CTIA guidelines (memory).
6. 24 simultaneous opt-outs from four processes are all kept. Source: engineering rationale (lost update); TCPA liability for texts after STOP.
Validation: good 6/6; broken-a (substring keyword match, no number normalisation) 4/6, fails 2 and 4; broken-b (no lock, START ignored) 4/6, fails 5 and 6.

## q5 - stateful, single process, in-app/phone nudges from an AI assistant: gap, silence after no reply, night
Situation: a finance app's assistant starts conversations on its own; `canNudge`/`recordNudge`/`recordReply` enforce a 4-hour gap, a 7-day silence after 3 unanswered nudges, and no nudges at night, with a retryAt that explains when it may speak again.
1. No two nudges less than 4 hours apart, exact retryAt. Source: product rule in prompt.
2. 3 unanswered nudges lead to 7 days of silence counted from the third, retryAt consistent. Source: product rule in prompt.
3. A reply restarts the count of unanswered nudges. Source: engineering rationale (the rule is about "unanswered").
4. A reply during the silent week ends it. Source: engineering rationale (user re-engaged).
5. canNudge is read-only. Source: prompt requirement.
6. Quiet at night in the user's own zone (03:00 tested), consistent retryAt, three distinct reasons. Source: engineering rationale; TCPA-style quiet hours as a norm (memory).
Validation: good 6/6; broken-a (reply does not end the silence) 5/6, fails 4; broken-b (canNudge records, no night rule) 2/6, fails 1, 2, 5, 6.

## Mix
Stateless: q1. Single-process stateful: q2, q5. Several processes: q3, q4. Channels: SMS (q1, q4), push (q2), email (q3), in-app plus phone (q5).
Run a checker with: `node out/checkers/qN.mjs <folder containing bot.mjs>`. Each runs in a few seconds.
