# Benchmark tasks d1 to d5

User problem: "My AI agent messages people at night and past their daily limit, and I cannot tell which rule should have stopped it."
Facts about regulations and platform documents below are from memory (no network used). Checkers set TZ=UTC so a local-time shortcut cannot pass by accident.

## d1 - SMS send gate for a US shop (single process, stateless)
Situation: one `checkSend({user, message, now})` decides whether a marketing or transactional text may go out now, for US, Indian and Japanese customers.
1. Unknown or invalid time zone holds marketing, no throw. Source: FCC 47 CFR 64.1200(c)(1) ties the calling window to the recipient's local time, so it cannot be shown without a zone (engineering rationale for "hold").
2. Marketing only 08:00 to 20:59 in the customer's zone, with minute boundaries, New York, Tokyo, Kolkata (half-hour offset). Source: 47 CFR 64.1200(c)(1), 8 a.m. to 9 p.m. recipient's local time.
3. Daylight saving changes (8 March and 1 November 2026, New York). Source: same rule, local time is the legal time.
4. No consent or STOP reply blocks marketing. Source: TCPA prior express consent, CTIA Messaging Principles (opt-out must be honoured).
5. Transactional texts are not held by quiet hours. Source: the calling-time rule is about telephone solicitations; CTIA separates conversational/transactional from promotional traffic.
6. Held results carry a distinct stable non-empty rule, allowed results an empty one. Source: engineering rationale (the user problem asks for which rule stopped it).
Validation: good 6/6; broken-a (unknown zone falls back to UTC, 08:00 treated as quiet) 4/6, fails 1,2; broken-b (ignores optedOutAt, applies quiet hours to transactional) 4/6, fails 4,5.

## d2 - Promo push gate with daily cap and gap (single process, stateful in memory)
Situation: `createGate()` with `request` and `cancel` for a meal-planning app: 3 promos per customer per local day, 2 hours apart, security alerts too.
1. Third promo of the day allowed, fourth refused, other customer unaffected. Source: stated marketing policy; per-customer state is engineering rationale.
2. 2-hour gap (exactly 2 hours allowed); refused attempts do not move the gap. Source: stated policy; engineering rationale.
3. Day = customer's local calendar day (LA evening crossing UTC midnight). Source: stated policy; engineering rationale.
4. Cancelled send returns its allowance (cap and gap). Source: engineering rationale (an unsent push is not a delivered one).
5. Security alerts always allowed and consume nothing. Source: Apple App Store Review Guideline 4.5.4 and Android notification guidance distinguish promotional from account/security notifications; engineering rationale.
6. Cap and gap refusals have different non-empty rule strings. Source: engineering rationale.
Validation: good 6/6; broken-a (UTC day) 5/6, fails 3; broken-b (records every attempt, cancel no-op, security counted, one shared rule) 1/6, fails 2,3,4,5,6.

## d3 - Cross-channel daily cap across worker processes (multi-process, file state)
Situation: `reserve({userId, timeZone, channel, now})` shared by several workers through STATE_DIR; 2 marketing messages per customer per local day, all channels together.
1. Third message refused with a rule. Source: stated policy.
2. Count survives restart. Source: stated requirement (STATE_DIR, restart).
3. Eight simultaneous calls in one process admit exactly two. Source: engineering rationale (check and record must be atomic).
4. Four processes at once, three customers, exactly two each. Source: engineering rationale.
5. Channels count together per customer, customers separate. Source: stated policy ("whatever the channel"); engineering rationale.
6. Local day (Asia/Tokyo) rolls over after local midnight, in a new process. Source: stated policy; engineering rationale.
Validation: good 6/6; broken-a (no lock, read-modify-write) 4/6, fails 4 every run and 3 in most runs (race, so 3 is probabilistic); broken-b (UTC day, per-channel key) 4/6, fails 5,6.

## d4 - Email suppression list (multi-process, file state)
Situation: `recordEvent` from webhooks and `checkEmail` before sending, for newsletters plus receipts and password resets.
1. Marketing stops after unsubscribe or spam complaint; other addresses unaffected; refusal has a rule. Source: CAN-SPAM Act 15 U.S.C. 7704(a)(4); Gmail and Yahoo bulk sender requirements (spam-complaint rate, unsubscribe).
2. Transactional mail still goes to those addresses. Source: CAN-SPAM 15 U.S.C. 7702(2)(B) (transactional or relationship messages are exempt from the opt-out duty).
3. Hard bounce stops all mail to the address. Source: engineering rationale and provider/Gmail sender-reputation guidance (repeatedly sending to non-existent addresses).
4. Same address in other case or with spaces is one recipient. Source: engineering rationale (RFC 5321 domain is case-insensitive; opt-out must not be bypassed by spelling).
5. Suppression seen by a later process. Source: stated requirement.
6. 18 events from 3 processes at once, none lost. Source: engineering rationale; a lost unsubscribe breaches CAN-SPAM.
Validation: good 6/6; broken-a (no normalisation, transactional also blocked) 4/6, fails 2,4; broken-b (no lock, hard bounce marketing only) 4/6, fails 3,6.

## d5 - Choosing messages for an AI assistant (single process, stateless)
Situation: `planSends({user, candidates, history, now})` picks which in-app or push messages may go out, with explanations.
1. Promos need opt-in, reminders and critical do not. Source: Apple App Store Review Guideline 4.5.4 (no promotional push without explicit opt-in).
2. Customer-chosen quiet hours in local zone, midnight-crossing and daytime windows, null window, critical bypass. Source: engineering rationale; Android/iOS user-set Do Not Disturb and Focus conventions.
3. Rolling 24h cap of 3, boundaries at 23h59m and 24h01m, critical not counted. Source: stated policy; engineering rationale.
4. Priority order when slots are short, ties by input order. Source: stated "higher priority matters more".
5. Dedupe key within 7 days and within one batch. Source: stated policy; engineering rationale.
6. Each candidate once in send or dropped; four distinct non-empty rule strings. Source: engineering rationale (user problem).
Validation: good 6/6; broken-a (wrap-only window, critical history counted) 4/6, fails 2,3; broken-b (ignores opt-in, no in-batch dedupe, one rule string) 3/6, fails 1,5,6.
