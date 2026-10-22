Wrote `bot.mjs` in the work directory. All 11 self-checks pass, including with the machine clock set to `Pacific/Kiritimati` (UTC+14), so the result doesn't depend on the server's zone.

**Behavior**
- Allowed only when the patient's local time is 08:00 up to but not including 21:00. Start minute is inclusive, end minute exclusive.
- Before 08:00 local, `nextAllowedAt` is 08:00 the same local day. At or after 21:00, it is 08:00 the next local day. The times are computed with `Intl`, so half-hour zones and DST changes are handled.
- A null, non-string, or unrecognised zone is held with `nextAllowedAt: null`, because the gate can't know when it will be safe. The scheduler needs to handle that case. It should not retry on a timer.
- An invalid `now` is also held with `nextAllowedAt: null`.
- The function is pure: no state, no network, no reads of machine time.

**Numbers I chose (not stated in your request)**
- Window: 08:00–21:00 patient-local. This is my reading of "be careful about when we text people". Change `WINDOW_START_MIN` and `WINDOW_END_MIN` at the top of the file if your policy differs.

**Assumptions and gaps**
- **Consent:** the patient object has no consent or opt-out field, so the gate does not check consent. It assumes your scheduler only passes patients who booked an appointment. If you want a consent check, give me the field name.
- **Opt-out / STOP:** not handled, since there is no input for it and you asked for no state. Inbound STOP needs to be enforced upstream.
- **Weekends and holidays:** not checked, since you didn't ask.
- **Phone:** not validated.

**Self-check:** I ran one inline script covering: in-window send; 21:00 exact (held); 20:59 (allowed); 08:00 exact (allowed); half-hour zone Asia/Kolkata and Australia/Adelaide; DST fall-back in America/Chicago on 2026-11-01 (07:59 held, 08:00 allowed); null zone; bogus zone; invalid `now`. I did not write a separate test file.
