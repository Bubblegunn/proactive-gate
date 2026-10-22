# Held-out tasks: never message people when you should not (written 2026-10-21)

- t1: multi-channel reminder gate with per-recipient quiet hours, rolling 24h/7d/channel caps and a US legal contact window (area code vs saved zone), plus a week run through a send stub (2026-10-21)
- t2: dispatcher for 50 concurrent sends and several workers on one state directory, crash-retry safety with an idempotency key, exactly-once cap accounting, and STOP/START handling (2026-10-21)
- t3: replay last week's 2,000 candidate messages under a current and a proposed policy, blocked counts by reason, per-message explanation and what changed (2026-10-21)

Run a checker: `node tN/checker.mjs <project-dir>`. Reference projects: `tN/ref/correct`; broken ones: `tN/ref/broken-*`. Fixture data is regenerated with `node tools/gen-data.mjs`.
