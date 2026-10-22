# T3 criteria (run: node checker.mjs <project-dir>)

Legal inputs come from data/policy.*.json (TCPA 47 CFR 64.1200(c)(1) 8am to 9pm; Fla. Stat. 501.059(8)(a); Oklahoma and Maryland stricter; counsel must confirm). The exercise is about replay semantics, not legal advice.

1. C1 Hand-built what-if with exact numbers: quiet:null vs missing key, quietDefault applied only to missing, cap cascade (a message freed by an earlier block), offset timestamps sorted by instant not string, duplicate id dropped once, DST-correct local time in details, newlyBlocked/newlyAllowed in processing order, inputs not mutated.
2. C2 Event timeline: stop, start, snooze, opt-out applied in instant order, event at the same instant applies before the message, snooze end exclusive, and the baseline run cannot leak state into the proposed run.
3. C3 Legal-window what-if for a Los Angeles user with a Miami number: allowed today, blocked by a tighter Florida end, detail names America/New_York and 19:45, summaries and newlyBlocked correct.
4. C4 The 2,000 row fixture week: totals, duplicates dropped (40), baseline and proposed summaries by primary reason, per-message reason codes for both policies, order, newly lists, byReason sums to blocked, every blocked message has readable detail, under 20 s.
5. C5 report.mjs prints sent/blocked and one line per reason with its count and the replay size, and writes one explained row per unique message.

Validation done by the author: ref/correct passes 5 of 5. broken-quiet-null fails C1, C4, C5; broken-string-sort fails C1, C2, C4, C5; broken-shared-state fails C2, C4, C5.
