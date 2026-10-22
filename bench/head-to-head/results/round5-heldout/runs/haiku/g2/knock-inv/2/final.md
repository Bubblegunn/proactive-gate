I wrote `bot.mjs` in the project directory and it passes my checks. Nothing was sent.

**How it decides**

- **Quiet hours first.** A push inside the user's quiet period returns `{ allowed: false, reason: "quiet_hours" }`. The caller sends immediately when allowed, so the gate can't queue a push for later. Blocked pushes are dropped.
- **Daily cap second.** "Per day" means the user's local calendar day, midnight to midnight in `user.timeZone`. A UTC day would split a Tokyo evening across two days, so I don't use it. Blocks return `{ allowed: false, reason: "daily_cap_reached" }`.
- **Overnight quiet periods.** If `quietStart` is later than `quietEnd`, the period wraps past midnight. Equal start and end means no quiet period. Start is inclusive and end is exclusive.
- **Only allowed pushes count.** A blocked attempt doesn't use up the cap.
- **Per-call settings.** Timezone, quiet hours and cap are read from each call's `user`. History is kept per user id in memory.
- **Bad input throws.** Invalid dates, times, cap values or time zones raise an error instead of silently allowing or blocking the push.

**Checks**

I ran a test script from `/tmp` (outside the project) covering:
- daytime allowed
- quiet-hour boundaries across midnight
- user time zone used for quiet hours
- cap reset at local midnight
- cap changing between calls
- independent gates and users
- check order
- invalid input
- a 20k-call run (about 144 ms)

Everything passed. I ran it on Node v24.13 because Node 22 isn't installed here. The code uses only long-standing APIs, but I haven't run it on Node 22.

**Choices to review**

- I didn't add a minimum gap between pushes (e.g. no two within 15 minutes). The brief only asked about night and daily volume, so that rule would change behavior you didn't request. It's a small addition if you want it.
- I used the Knock skill's rules: quiet hours, per-day caps, and dropping rather than queuing. I did not open Apple's or Google's notification guidelines during this session, so I haven't checked the code against their exact wording.
