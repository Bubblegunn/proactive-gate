I wrote `bot.mjs` in the project root and tested it. Nothing is sent. The self-check ran on Node v24.13.0 (the machine's version), not Node 22. The code only uses standard Intl and Date features that Node 22 has, but I didn't run it on 22.

**What it does**

- **Quiet hours:** a text is allowed only when the patient's local time is 08:00 to 21:00. 08:00 is included and 21:00 is excluded. Outside that window the reason says so, and `nextAllowedAt` is the first whole minute when the local clock is back inside it. I step minute by minute, so DST changes and half-hour zones like Asia/Kolkata come out right.
- **Missing or invalid time zone** (null, empty, or an unknown name): held, `nextAllowedAt: null`. It never guesses a zone.
- **Missing phone:** held, `nextAllowedAt: null`.
- **Invalid `now`:** held, `nextAllowedAt: null`.
- No network, no files, no state, no use of the machine's time zone.

**Assumptions to check**

- **Consent:** the user object has no consent or opt-out field, so I treat an appointment reminder as something the patient signed up for by booking. Reminders are allowed without a consent field. If your patients need a per-patient opt-in for SMS, the function can't see it today.
- **STOP replies are not checked.** The data has no opt-out field, and you said the code has no state, so an inbound STOP has no way to reach it. Until that's wired in, a patient who texts STOP will still get reminders from this gate. That is the most likely source of another complaint.
- **Window of 08:00–21:00 local** is my choice. It matches the usual US telemarketing hours, but I'm not giving legal advice. If your counsel wants a narrower window, change the two constants at the top of the file.
- I did not use the `proactive-gate` library. The project lists it as a dependency, but it isn't installed and you asked for a single file.

**Self-check results** (all as expected)

- Chicago at 14:00 CDT, 20:59 CDT and 08:00 CDT: allowed.
- Chicago at 21:00 CDT: held, retry 08:00 the next day (13:00Z).
- Chicago at 07:59 CDT: held, retry 08:00 (13:00Z).
- Chicago on the fall-back day at 06:00 CST: held, retry 14:00Z.
- Kolkata at 07:30 IST: held, retry 08:00 IST (02:30Z). Kolkata at 08:00 IST: allowed.
- Null zone, bogus zone, empty phone, invalid `now`: held with `nextAllowedAt: null`.
