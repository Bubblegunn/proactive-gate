# Benchmark tasks p1 to p5

Problem all five come from: "My AI agent messages people at night and past their daily limit, and I cannot tell which rule should have stopped it."
Sources below are cited from memory (no network was used); check exact section numbers before quoting them elsewhere.
Run a checker with: `node checkers/pN.mjs <folder containing bot.mjs>`. All checkers finish in about 1 second.

## p1 - US marketing SMS with quiet hours (single process, stateless)
Situation: decide synchronously whether one SMS may go out now, given recipient zone, kind and consent.
1. No marketing text before 08:00 recipient local time. Source: FCC telemarketing rules, 47 CFR 64.1200(c)(1) (8 a.m. to 9 p.m. called-party time).
2. No marketing text after 21:00 local. Source: same rule.
3. Recipient zone and daylight saving respected, not the server zone. Source: same rule (called party's local time); engineering rationale for UTC servers.
4. Transactional texts (codes, delivery updates) are not held at night. Source: engineering rationale; the TCPA quiet-hours rule is about telemarketing, and CTIA messaging principles treat requested messages differently.
5. Marketing without consent blocked, transactional unaffected. Source: TCPA prior express written consent for marketing texts (47 CFR 64.1200(a)(2)); CTIA Messaging Principles (STOP handling).
6. blockedBy named; nextAllowedAt is the next 08:00 local instant, correct across a DST change. Source: engineering rationale (support must see which check stopped a text; retry scheduling).
Validation: good 6/6; broken-a (ignores recipient zone, uses UTC) 2/6, fails 1,2,3,6; broken-b (holds transactional at night, computes retry time with the current offset) 4/6, fails 4,6.

## p2 - Daily marketing email cap across worker processes (multi-process, stateful)
Situation: async reservation function, 3 marketing emails per recipient-local calendar day, shared STATE_DIR.
1. Fourth marketing email on one local day is refused. Source: product rule in the prompt (engineering rationale).
2. The allowance resets at the recipient's local midnight, not UTC midnight. Source: engineering rationale ("recipient's own calendar day" in the prompt); recipient experience.
3. Two worker processes at once cannot exceed the cap. Source: engineering rationale (atomic reservation).
4. Count survives a restart. Source: engineering rationale (the prompt requires survival of restarts).
5. Transactional email is neither refused nor counted. Source: CAN-SPAM Act, 15 U.S.C. 7702(2) and 7704 (transactional or relationship messages are treated differently); Gmail and Yahoo bulk sender requirements concern marketing mail.
6. Per-recipient independence, blockedBy named on refusal and empty on allow. Source: engineering rationale.
Validation: good 6/6; broken-a (no locking, read-modify-write with a gap) 5/6, fails 3; broken-b (UTC day, counts transactional) 4/6, fails 2,5.

## p3 - Mobile push gate with opt-in, quiet hours and duplicate suppression (single process, in-memory state)
Situation: createGate().check(msg, now) for an AI assistant's push notifications.
1. Per-category opt-in is enforced; other opted-in categories still arrive. Source: Apple App Review Guideline 4.5.4 (promotional push needs explicit opt-in); Google Play notification policy.
2. Overnight quiet window 22:00 to 07:00, start inclusive, end exclusive, wrapping midnight, plus a daytime custom window. Source: engineering rationale; platform do-not-disturb behaviour.
3. Quiet hours evaluated in the user's zone including DST. Source: engineering rationale.
4. Security alerts bypass opt-in and quiet hours. Source: engineering rationale (account safety); platform guidance treats security notices as not promotional.
5. Same user and dedupeKey not delivered twice within 24 hours, and a notification held back by quiet hours is not recorded as sent. Source: engineering rationale (at-least-once job delivery).
6. blockedBy distinguishes opt-out, quiet hours and duplicate; empty when allowed. Source: engineering rationale (the user problem: which rule stopped it).
Validation: good 6/6; broken-a (quiet hours evaluated in UTC) 5/6, fails 3; broken-b (records the key before the other checks, one generic blockedBy) 4/6, fails 5,6.

## p4 - Agent contact limits with retry time across processes (multi-process, stateful, rolling windows)
Situation: requestSend({userId, now}); never more than 4 contacts in any 7 days, never 2 within 2 hours; returns retryAt.
1. Two-hour gap enforced; refused attempts do not extend it. Source: product promise in the prompt; WhatsApp Business messaging policy (user-experience and frequency expectations, from memory).
2. Rolling seven-day cap of four, allowed again after the oldest contact ages out; limit named distinctly from the gap. Source: product promise; engineering rationale.
3. retryAt after a gap refusal is the first moment a request passes (probe at +1 min passes, -1 min refused). Source: engineering rationale.
4. retryAt after a weekly refusal, also when the gap applies too, satisfies both limits. Source: the prompt's "all of them are satisfied".
5. Simultaneous requests from two processes give exactly one slot per person. Source: engineering rationale (atomic reservation).
6. Contacts from earlier, ended processes still count. Source: engineering rationale.
Validation: good 6/6; broken-a (in-memory state only) 4/6, fails 5,6; broken-b (records refused attempts as contacts, retryAt always now plus 2 h) 2/6, fails 1,2,3,4.

## p5 - Email suppression list shared by workers (multi-process, stateful)
Situation: unsubscribe, recordBounce and mayEmail with a shared directory.
1. Unsubscribed address gets no marketing email. Source: CAN-SPAM Act, 15 U.S.C. 7704(a)(4) (opt-out must be honoured).
2. Capitals and stray spaces do not defeat the suppression. Source: engineering rationale (addresses are matched case-insensitively in practice); CAN-SPAM opt-out must work for the address the person used.
3. Transactional email still allowed after an unsubscribe. Source: CAN-SPAM 15 U.S.C. 7702(2)(B) and 16 CFR 316.3 (transactional or relationship messages are outside the opt-out).
4. Hard bounce stops all mail; soft bounce stops none. Source: email provider bounce-handling policies (reputation and account suspension), from memory.
5. A suppression written by one process is seen by a later process. Source: engineering rationale.
6. Thirty simultaneous unsubscribes from two workers are all kept. Source: engineering rationale (no lost updates).
Validation: good 6/6; broken-a (no normalisation, unsubscribe blocks transactional too) 3/6, fails 2,3,5 (5 fails only because its transactional probe blocks); broken-b (unlocked read-modify-write, soft bounce suppresses) 4/6, fails 4,6.

## Notes
- The reference implementations in `ref/pN-good` use a mkdir-based lock plus an atomic rename in STATE_DIR; the checkers accept any layout.
- The checkers set `process.env.STATE_DIR` to a fresh temp directory before loading `bot.mjs`, so code that reads it at import time or at call time both work.
- Boundaries that the prompts leave ambiguous (exactly 21:00, exactly 2 hours) are not probed; probes sit one minute to either side.
