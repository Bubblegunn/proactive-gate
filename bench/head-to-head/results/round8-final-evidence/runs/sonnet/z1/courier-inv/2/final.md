`bot.mjs` is written and passed my checks. I tested it with a script in `/tmp/t1`, so nothing else was added to the project folder. I'm now wrapping up this summary.

`decide` returns `{ send: false, reason }` in any of these cases, and `{ send: true, reason: null }` otherwise:
- **Emergency flag:** `flags.proactiveEnabled` is not `true`.
- **Consent:** `consents.marketing` is not explicitly `true`. Missing or empty consents count as no consent.
- **Opt-out:** the user switched off that type with `optOut`.
- **Dismissals:** each `recordDismissal` for a type pauses it, for 3 days after the first, 7 after the second, and 30 after the third or later. The count resets after 90 quiet days, and other types are unaffected.
- **Time of day:** it only sends from 09:00 to 19:59 in the user's local time. It uses `deviceTimezone` first, then `timezone`. A missing, invalid or `"UTC"` placeholder zone is ignored, and if neither is usable it does not send.
- **Frequency:** one notification per type per local day, two per day across all types, and the same `candidate.id` is never delivered twice.
- **Bad input or unreadable state:** it does not send.

State is one JSON file per user in `STATE_DIR`, created if needed and written atomically, so it survives restarts. A per-user lock directory keeps the check and the record in one step across workers.

Checks that passed:
- Time zones: device zone preferred, saved zone as fallback, and `"UTC"` or invalid zones rejected.
- Window and daily caps.
- Consent: missing consents and empty consents both block.
- Emergency flag.
- Dismissal pause and its expiry.
- Opt-out blocking only the opted-out type.
- State surviving a restart in a fresh process.
- Twelve separate processes racing on the same user and day: exactly one got `true`.

I did not install any dependencies, and nothing is sent anywhere. The Courier skill says cadence is a product decision, so the limits above (hours, caps, pause lengths) are my choices. They are constants at the top of `bot.mjs` if you want different values.

I also treated every proactive type, including `tip`, as needing `marketing` consent, since the data gives no way to tell which purpose a type belongs to. Say so if the check-in should use a different consent purpose.
