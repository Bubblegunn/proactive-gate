`bot.mjs` is written and passes my check script. There are no dependencies, so `package.json` is unchanged. The script covers each rule below, restart persistence, and 12 processes racing for one user. It is in `/tmp/botcheck/test.mjs`, outside your folder. Nothing is actually sent.

`decide` sends only when all of these hold; otherwise it returns `send: false` with a plain-sentence reason.
- **Kill switch:** `flags.proactiveEnabled` must be exactly `true`. Missing flags also block.
- **Types:** only `checkin` and `tip` can be sent. Any other type is blocked.
- **Consent:** `consents.marketing` must be exactly `true`. Missing, empty, or `false` blocks. I assumed check-ins and tips count as marketing; change `CONSENT_PURPOSE` if you use another purpose key.
- **Opt-out:** `optOut` is permanent for that type and survives restarts. Other types are unaffected.
- **Time zone:** `deviceTimezone` is used first. Otherwise `timezone` is used, except the placeholder "UTC". If no real zone is known, nothing is sent, because quiet hours can't be checked.
- **Quiet hours:** sends only between 09:00 and 20:00 in the user's local time.
- **Dismissal back-off:** each swipe pauses that type for 3 days, then 7, then 30, then 90. The count resets after 90 days with no swipe. Other types are not paused.
- **Frequency:** one per type per local day, and at least 12 hours apart. At most 2 notifications of any type per local day, and at least 4 hours between any two.
- **Repeat calls:** a candidate id that was already delivered is not delivered again.
- **State errors:** if the state can't be read or locked, it sends nothing.

State is one JSON file per user in `STATE_DIR`. Each file is replaced atomically and guarded by a lock file shared across worker processes. A damaged state file blocks sending. It is not reset, because a reset would forget opt-outs. `optOut` and `recordDismissal` throw if `STATE_DIR` is unset or the state can't be written, so a lost opt-out is never silent.

The numbers (window, caps, back-off steps) are constants at the top of `bot.mjs` if you want different values.
