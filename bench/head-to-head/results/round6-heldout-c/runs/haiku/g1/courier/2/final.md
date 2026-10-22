I wrote `bot.mjs` and a test file, `bot.test.mjs`, in the working directory. Nothing is sent or committed.

**What `checkSms(user, now)` does**

- **Allowed:** texts go out only when the patient's local clock reads 08:00 to 20:59:59. The window is 08:00 inclusive to 21:00 exclusive, which matches the US federal TCPA calling window. Returns `allowed: true`, `nextAllowedAt: null`.
- **Too early or too late:** returns `allowed: false` and a support-readable reason, e.g. `Held: it is 06:30 in America/Chicago; reminders go out only from 08:00 to 21:00 local time.` `nextAllowedAt` is the exact instant of the next 08:00 local. Before 08:00 that is later the same day; at or after 21:00 it is 08:00 the next calendar day.
- **No usable time zone:** `timezone` is null, empty, not a string, or not a valid IANA name. Returns `allowed: false` with `nextAllowedAt: null`, since there is no way to know when the patient will set a zone.
- **Invalid `now`:** held, with `nextAllowedAt: null`.

The function is synchronous and pure. It uses only `Intl` and `Date` arithmetic, never reads the machine's zone, and makes no network calls.

**Verification**

- `node --test bot.test.mjs`: 11/11 pass. I ran it under four machine time zones (UTC, Tokyo, Los Angeles, Kiritimati) and got the same result each time. The tests cover the boundaries, month rollover, a half-hour zone (Asia/Kolkata), a US spring-forward DST day, and the invalid-zone cases.
- A sweep of every 15 minutes across 2026 for seven zones, including DST zones and 30- and 45-minute offsets (245,280 instants), found no errors. For every held instant, `nextAllowedAt` is allowed and one second earlier is still held.
- The sandbox runs Node 24, not 22. I used only long-standing APIs, but I did not run it on Node 22.

**Choices for you to confirm**

1. **Patients with no valid time zone are never texted.** That is the strict reading of "be careful", but reminders for those patients will sit held until someone fixes their zone. The alternative is a conservative fallback, such as sending only in the window that is quiet in every US zone (18:00–01:00 UTC). Tell me if you want that instead.
2. **Window:** 08:00–21:00. If you want something tighter, change `SEND_START_HOUR` and `SEND_END_HOUR` at the top of `bot.mjs`.
3. **No frequency cap.** Capping how many texts a patient gets would need state, and you asked for none. The scheduler or the vendor would have to enforce that.
4. **No phone-number validation.** I did not add a check on `phone`, since the request did not ask for one.

The legal wording of the TCPA rules is a question for your compliance or legal reviewer. I did not check it.
