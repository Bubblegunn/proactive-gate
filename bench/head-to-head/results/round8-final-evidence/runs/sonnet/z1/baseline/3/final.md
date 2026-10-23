`bot.mjs` is written and passes my checks. It needs no dependencies, so `package.json` is unchanged. Nothing is actually sent.

**What `decide` checks.** Any failing check gives `send: false` with a plain-sentence reason:
1. **Kill switch:** `flags.proactiveEnabled` must be exactly `true`.
2. **Valid input:** it needs a user id, a candidate with an id and a type, and a valid `now`.
3. **Consent:** `consents.marketing` must be `true`. A missing or empty `consents` counts as no consent.
4. **Opt-out:** a type the user switched off stays off, and other types are unaffected.
5. **Local time:** it sends only between 09:00 and 20:00 in the user's local time.
   - It uses `deviceTimezone` first, then `timezone`.
   - It ignores `UTC` as a placeholder and any invalid zone.
   - If no real zone is known, it does not send, because quiet hours can't be checked.
6. **Frequency:**
   - A type is sent at most once per local day, with at least 20 hours between sends of that type.
   - Different types must be at least 2 hours apart, with at most 3 sends in any 24 hours.
   - The same candidate is never delivered twice.
7. **Dismissal back-off:** each dismissal of a type in a row doubles the quiet period (2, 4, 8, 16, then 30 days). The count resets if the last dismissal was more than 90 days ago.

**Shared state.**
- Each user gets one JSON file in `STATE_DIR`, which is created if it doesn't exist. Writes are atomic.
- A per-user lock lets several worker processes share the directory. A stale lock is cleared after 10 seconds.
- The send is recorded before `decide` returns `send: true`, so it counts as delivered.
- If the state is corrupt or the lock times out, it does not send.

**What I ran.** Single-process tests covered:
- the kill switch and missing consent
- quiet hours
- the `UTC` placeholder falling back to the device zone, and unknown zones
- once per day, and sending again the next day
- dismissal back-off
- opt-out, with other types unaffected

I also launched 8 worker processes at once for the same user: exactly 1 sent. A fresh process afterwards was still blocked, so state survives a restart.

**Assumptions to confirm:**
- I treat the check-in as needing the `marketing` consent. If you have a different purpose key for it, change that one line in `decide`.
- `optOut` is permanent, because the app gives me no "switched back on" hook. If users can re-enable a type, add a function that clears the flag.
