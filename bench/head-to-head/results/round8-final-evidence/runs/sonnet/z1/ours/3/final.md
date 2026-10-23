`bot.mjs` is written and exports `decide`, `recordDismissal` and `optOut`. It needs no dependencies, so there is no `package.json` change. I checked it against a temporary `STATE_DIR` by calling the exported functions directly. Nothing is sent.

What the check covered:
- **Allowed case:** a normal user at 12:00 New York time gets a check-in.
- **Repeat id:** the same message id gets the same answer and spends nothing twice.
- **Daily limit:** a second check-in the same local day is held, with a retry time.
- **Quiet hours:** a user at 23:00 local is held until 08:00, with the retry time given as local clock time and zone.
- **Time zone:** a missing zone, or the saved placeholder "UTC" with no device zone, is held. The device zone is used first when it is valid.
- **Holds:** `proactiveEnabled: false`, a `marketing` consent that is false, and an empty or missing `consents` are all held.
- **Opt-out:** `optOut` blocks only that type; a "tip" still goes through for the same user.
- **Dismissal:** a dismissal pauses that type for the set time.
- **Parallel workers:** six separate processes sent for one user at once, and exactly one was allowed.

I did not check restart survival directly, or a daylight-saving boundary. State is written to files in `STATE_DIR`, but I did not stop and restart a process to test it.

Numbers I chose:
- **Sending window:** 08:00 up to, but not including, 21:00, in the recipient's local time.
- **Per-type cap:** 1 notification per type per local day.
- **Overall cap:** 3 notifications of any type per local day.
- **Dismissal pause:** after the nth dismissal, that type pauses for min(2^n, 14) days, so 2, 4, 8, then 14.

Assumptions:
- **Consent key:** you did not name a consent purpose for check-ins and I did not want to invent one, so every type requires `consents.marketing === true`. Absent or false means off. If check-ins should use a different key, change `CONSENT_PURPOSE` at the top of the file.
- **Zone fallback:** if the device zone is invalid, the saved zone is used instead. The placeholder "UTC" counts as unknown.
- **Opt-out scope:** opt-out is per type and overrides everything else.
- **Duplicate delivery:** a repeated message id that was already delivered returns `send: true` again, because the same id must give the same answer. The app must not deliver it a second time.

Held results also carry `nextAllowedAt` (a `Date`) when there is a retry time.
