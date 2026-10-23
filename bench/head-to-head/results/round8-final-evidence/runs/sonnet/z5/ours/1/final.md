`bot.mjs` is written and works. I ran 9 checks and all 9 behaved as intended. The second run in the same state directory gave the same answers after a restart. Nothing is sent.

**Rules in `decide`:**
- **Repeat delivery:** the same candidate id gets the same answer and spends nothing twice. Claims are atomic, so two workers can't both win.
- **Crisis:** nothing is shown, on any surface.
- **Low value:** nothing is shown if `dataPoints` or `confidence` is missing, or below the minimums below.
- **Repeat finding:** the same `insight.key` is shown at most once per recipient local day. The refusal reason gives the retry time as a local clock time with the zone name, plus a `nextAllowedAt` field.
- **Focus mode:** push is dropped and only `inApp` is shown. If `focusMode` is missing, I treated it as on.
- **Bad hours:** push is dropped for the user's local hour when at least 5 earlier messages were shown in that hour and more than 70% were dismissed. `inApp` is still shown.
- **Unknown data:** a missing or invalid time zone, a missing `crisis` flag, or a missing user or candidate id holds everything. The reason says why.

**Numbers I chose:**
- Minimum confidence: 0.6.
- Minimum `dataPoints`: 3.
- Hour history minimum: 5 samples.
- Dismissal share: more than 70%.
- Repeat-finding suppression: until the end of the local day.

**Not enforced:** you gave no consent, opt-out, quiet hours or push cap, so I added none. I treated the messages as ones the user signed up for. If you have an opt-out record or a quiet-hours window, tell me and I'll add it.

**Not checked:** I didn't test two workers racing on one candidate id. The tests used the dummy time zones and hour stats in my script, not real app data.

I used the kit's inline helpers, appended to `bot.mjs`, so no dependency was needed.
