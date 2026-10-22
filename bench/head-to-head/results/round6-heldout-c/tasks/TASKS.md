# Tasks g1 to g5

All facts about regulations and platform rules below are from memory (no lookup was done). Run all validations with `zsh out/run.sh g1 g2 g3 g4 g5`.

## g1 — SMS appointment reminders, stateless, one process
Situation: a clinic app asks `checkSms(user, now)` before texting a patient; the patient's IANA time zone may be missing.
1. Held at night local time (Chicago, Kolkata, Los Angeles) — US TCPA / FCC rule on telephone solicitations (8:00 to 21:00 recipient local time, 47 CFR 64.1200(c)); CTIA messaging principles.
2. Allowed at midday local time, including a half-hour zone — same rule; engineering rationale (do not block legitimate sends).
3. Edges 07:59 / 08:01 / 20:59 / 21:01 — TCPA 8:00-21:00 window.
4. Daylight-saving change days (America/New_York, 2026-03-08 and 2026-11-01) — engineering rationale; same TCPA rule.
5. `nextAllowedAt` equals the next 08:00 local instant — engineering rationale (scheduler retry).
6. Missing or invalid time zone is not texted — engineering rationale (fail closed under TCPA; local time unknown).
Validation: good 6/6; broken-a (fixed standard offsets, no DST) 2/6, fails 1,3,4,5; broken-b (unknown zone falls back to UTC, nextAllowedAt always null) 4/6, fails 5,6.

## g2 — Food-delivery push, stateful in memory, one process
Situation: `decide(candidate, now)` must hold marketing pushes in the customer's do-not-disturb window and over 3 per local day, but never hold courier or security pushes.
1. Quiet window incl. wrap past midnight is honoured — engineering rationale; Apple HIG / Android notification guidance on not interrupting users.
2. Fourth marketing push per day is held — engineering rationale (product limit stated in prompt).
3. Pushes held by quiet hours do not use up the allowance — engineering rationale.
4. Transactional pushes are exempt from and not counted in the cap — Apple App Store Review Guideline 4.5.4 distinguishes promotional pushes; engineering rationale.
5. Allowance restarts at the customer's local midnight (NY and Tokyo) — engineering rationale (prompt states local day).
6. Rule identifiers distinguish cap from quiet hours — engineering rationale (the user's "which rule stopped it" problem).
Validation: good 6/6; broken-a (UTC-day cap, non-wrapping quiet window) 2/6, fails 1,3,5,6 (the wrap bug also hits 1,3,6 by accident); broken-b (counts every attempt and category, one generic rule) 3/6, fails 3,4,6.

## g3 — Email unsubscribe list, several worker processes, shared STATE_DIR
Situation: `unsubscribe`, `resubscribe`, `mayEmail(email, kind, now)` shared by workers through a directory.
1. Unsubscribe by one worker binds another — CAN-SPAM Act 15 U.S.C. 7704(a)(4) (honour opt-out; 10 business days); GDPR Art. 21(2)-(3) right to object to direct marketing; RFC 8058 one-click unsubscribe.
2. Case and whitespace do not get around it — engineering rationale (CAN-SPAM requires honouring the person's request; addresses are case-insensitive in practice).
3. Receipts and password mails still go — CAN-SPAM "transactional or relationship messages" exemption (7702(17)).
4. Concurrent unsubscribes are all kept — engineering rationale; CAN-SPAM 7704(a)(4).
5. Resubscribe restores that address only — GDPR Art. 7 / CAN-SPAM (explicit new consent); engineering rationale.
6. Missing STATE_DIR created and survives restarts — engineering rationale.
Validation: good 6/6; broken-a (single JSON file read-modify-write without a lock, no normalisation, blocks all kinds) 2/6, fails 2,3,4,5; broken-b (in-memory set) 0/6.

## g4 — AI agent per-customer rate limit, several worker processes, shared STATE_DIR
Situation: `reserve(userId, channel, now)` caps proactive agent messages at 5 per rolling 24 hours across channels.
1. Sixth message refused across processes and channels, other users unaffected — engineering rationale (product limit); CTIA/Apple guidance on message frequency.
2. Racing workers never exceed the limit — engineering rationale (atomic check and count).
3. Sliding window, not calendar day — engineering rationale (prompt says any 24-hour period).
4. `retryAt` is when the oldest message ages out (within 5 s) — engineering rationale.
5. Refused attempts are not counted; slots free one at a time — engineering rationale.
6. Missing nested STATE_DIR created and shared — engineering rationale.
Validation: good 6/6; broken-a (no lock between read and write) 5/6, fails 2; broken-b (UTC calendar day) 3/6, fails 3,4,5.

## g5 — WhatsApp/SMS support assistant, in memory, one process
Situation: `onInbound(userId, text, at)` and `check(userId, type, now)` decide on free text, templates, and opt-outs.
1. Free text allowed within 24 hours of the customer's last message — WhatsApp Business Platform customer service window (24 h).
2. Free text held after 24 hours or for a customer who never wrote; templates still allowed — WhatsApp Business Platform message templates.
3. A newer inbound message restarts the window — WhatsApp Business Platform.
4. STOP, " stop ", "Stop.", "stop!", UNSUBSCRIBE, Quit block everything — CTIA Messaging Principles and Best Practices (opt-out keywords); TCPA 47 CFR 64.1200(a)(10) (revocation of consent).
5. START lifts the stop — CTIA Messaging Principles (opt-in/keyword conventions).
6. Sentences containing "stop" are not opt-outs — engineering rationale (avoid silencing customers wrongly).
Validation: good 6/6; broken-a (substring match, no QUIT) 4/6, fails 4,6; broken-b (window never refreshed, STOP only blocks free text, no START) 3/6, fails 3,4,5.
