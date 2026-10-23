# Benchmark tasks r1 to r5

User problem: an AI agent messages people at night and past their daily limit, and the developer cannot tell which rule should have stopped it. Every prompt asks for a `rule` field so the cause of a refusal can be seen. Facts about regulations and platform documents below are from memory, no source was opened.

Checkers: `node out/checkers/rN.mjs <folder with bot.mjs>`. Reference code: `out/ref/rN-good`, `rN-broken-a`, `rN-broken-b`. Labels: `out/labels.json` (all outcome).

## r1 SMS marketing gatekeeper (stateless, single process)
Situation: US retailer's agent texts customers; decide per user and time whether a promotional SMS may go out.
1. Quiet hours 08:00 to 21:00 recipient local time. Source: FCC TCPA rule 47 CFR 64.1200(c)(1).
2. Recipient's own IANA zone, not server zone. Source: same rule ("at the called party's location").
3. Daylight saving transitions correct. Source: same rule; engineering rationale.
4. Consent and opt-out ordering (latest event wins). Source: 47 CFR 64.1200(a) and (c) revocation of consent; CTIA principles.
5. Unknown zone fails closed without a crash. Source: engineering rationale (cannot prove the rule is met).
6. Distinct rule name per cause. Source: engineering rationale (the user problem).
Validation: good 6/6. broken-a (fixed standard offsets, no DST) fails 3. broken-b (ignores opt-out, throws on bad zone) fails 4, 5, 6.

## r2 Promotional push daily cap (stateful, several processes)
Situation: workers share STATE_DIR; at most 3 promotional pushes per user per local day, transactional pushes unaffected.
1. Cap of 3 per user per day. Source: product requirement stated in the prompt.
2. Day is the user's local calendar day. Source: engineering rationale (prompt says users read "per day" as their own).
3. Exactly 3 allowed under concurrent calls from 3 processes. Source: engineering rationale (check-then-act race).
4. Count survives restart. Source: prompt requirement.
5. Transactional pushes neither refused nor counted. Source: Apple and Google notification guidance on reliable important alerts (from memory), engineering rationale.
6. Per-user counts. Source: engineering rationale.
Validation: good 6/6. broken-a (in-memory map) fails 3, 4. broken-b (files, no lock, UTC day) fails 2, 3.

## r3 Email campaign gate (stateless)
Situation: shop selling in US, UK and EU; agent must ask whether an email may go to a mail provider.
1. List-Unsubscribe header required on marketing. Source: Gmail and Yahoo bulk sender requirements 2024; RFC 2369.
2. List-Unsubscribe-Post one-click header required. Source: same requirements; RFC 8058.
3. Postal address required on marketing. Source: US CAN-SPAM Act, 15 U.S.C. 7704(a)(5).
4. Suppress unsubscribed, complained, hard-bounced recipients; soft bounce allowed. Source: CAN-SPAM opt-out duty (7704(a)(4)); mailbox-provider complaint-rate guidance; engineering rationale for bounces.
5. EU/EEA/UK need consent; US without answer may be mailed. Source: ePrivacy Directive Art. 13, UK PECR reg. 22; CAN-SPAM is opt-out.
6. Transactional exempt from the marketing rules. Source: CAN-SPAM 7702(2)(B) and 7704; Gmail guidance exempting transactional mail from one-click.
Validation: good 6/6. broken-a (no one-click, no address check) fails 2, 3. broken-b (no transactional exemption, no regional consent) fails 5, 6.

## r4 WhatsApp Business agent (stateful, several processes)
Situation: agent starts conversations; decide per user and message kind, with state shared across workers.
1. Free-form only within 24 hours of the last inbound message. Source: WhatsApp Business Platform customer service window.
2. Approved templates usable outside the window for opted-in customers; free-form not without a message. Source: same.
3. Newer inbound extends the window; late older event cannot shorten it. Source: engineering rationale (webhooks arrive out of order; prompt states it).
4. Shared and persistent state. Source: prompt requirement.
5. Opt-out blocks both kinds. Source: WhatsApp Business Messaging Policy (honour opt-out).
6. No opt-in on record means no template. Source: WhatsApp Business Messaging Policy (opt-in required for business-initiated messages).
Validation: good 6/6. broken-a (in-memory) fails 4. broken-b (window from first inbound, opt-out blocks templates only) fails 3, 5.

## r5 SMS keyword handling (stateful, single process)
Situation: two US programmes (32665 alerts, 32666 promotions); track STOP/START/HELP.
1. STOP-family keywords opt out, any case, trimmed. Source: CTIA Messaging Principles and Best Practices.
2. Sentences containing a keyword do not opt out. Source: CTIA (keyword must be the whole message); engineering rationale.
3. STOP and HELP get an automatic reply; HELP does not opt out. Source: CTIA; carrier programme requirements.
4. START and UNSTOP resubscribe. Source: CTIA.
5. Phone number format normalisation. Source: engineering rationale (prompt gives the formats).
6. Opt-out scoped to the programme number. Source: CTIA (opt-out applies to the programme); carrier practice.
Validation: good 6/6. broken-a (word match anywhere) fails 2. broken-b (no number normalisation, not per programme) fails 5, 6.

Run order check: all 15 reference runs completed in under 2 seconds each.
