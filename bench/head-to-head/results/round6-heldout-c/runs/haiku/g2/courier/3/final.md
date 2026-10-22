I wrote `bot.mjs` in the work directory and checked it with a behavior script. All checks pass.

**What `decide(candidate, now)` does, in order:**

1. **Transactional** → always `{ send: true, rule: null }`. It ignores quiet hours and the cap, and it is not counted.
2. **Marketing, quiet hours** → if the customer's local time is inside their quiet window, `{ send: false, rule: "quiet-hours" }`.
3. **Marketing, daily cap** → if the customer already has 3 marketing sends on their local calendar day, `{ send: false, rule: "daily-cap" }`.
4. Otherwise `{ send: true, rule: null }`, and the send is counted.

Local day and local time come from `Intl.DateTimeFormat` using the customer's `timezone` and the `now` you pass in. The server clock is never read.

**Decisions I made that you should confirm:**

- **Quiet hours apply to marketing only.** Your spec only said transactional must get through the cap. I assumed a security code or courier alert should also get through the quiet window. If quiet hours should block everything, change the transactional branch.
- **Rule precedence is quiet-hours before daily-cap.** If both apply, the reported rule is `quiet-hours`. A quiet-blocked push is not counted toward the cap.
- **Quiet window is `[start, end)`.** Start is inclusive and end is exclusive. `start === end` means no quiet window, not all day.
- **Invalid input throws** (`TypeError` for bad category, bad `HH:MM`, bad `now`; `RangeError` for an unknown IANA zone). It does not return a silent `send: false`.
- **Memory is bounded.** Per user, counts for dates older than yesterday are dropped on each call. A restart clears everything, as you allowed.
- **Concurrency:** `decide` is synchronous, so the check and the increment cannot interleave within one process. This does not hold across multiple processes; there, each process has its own counts.

**Verification:** I ran a check script in `/tmp/bot-test/check.mjs`, outside the repo. It covers transactional bypass, the cap reaching 3 then blocking, local-midnight bucket reset (Istanbul and New York), wrap-around quiet hours with inclusive start and exclusive end, quiet-blocked sends not counting toward the cap, non-wrapping and empty windows, invalid input throwing, and memory pruning. It passes on Node 24.13. The code uses only `Intl.formatToParts`, `hourCycle`, and `Date.UTC`, which are available in Node 22, but I did not run it on Node 22 itself.

I did not send anything. Nothing was committed.
