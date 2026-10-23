`bot.mjs` is written and checked with a throwaway script. The script is in `/tmp`, not in this folder. No dependency was needed.

**Self-check (all passed)**
- A normal briefing sends both push and in-app.
- Sending the same id again returns the same answer and calls the transport once.
- A snoozed user gets the in-app item and no push. `resumeAt` is the `snoozedUntil` time as an ISO string.
- The category set to false, no consent, and a throwing consent store each send nothing.
- Notification permission set to false sends in-app only.
- Four parallel calls with one id sent one push and one in-app item.
- `recordDismissal` writes to `STATE_DIR`.

I did not test a restart, or two separate worker processes. State is plain files in `STATE_DIR`, written atomically.

**Choices I made where the request was silent**
- **Consent key:** I read the consent for a candidate as `consents[candidate.type]`, e.g. `consents.briefing`. If your store names purposes differently, change that one lookup. Absent or false means nothing is sent.
- **Category choice:** a briefing is sent when the category is missing (the user was never asked) and held when it is false. Other card types need an explicit true.
- **Snooze and permission:** these hold only the push. The in-app item is a silent surface, so it still goes out.
- **Failed send:** if the push returns false, `inApp` is still delivered and `reason` says the phone did not accept it. If a transport call throws, the claim is kept so the id is never sent twice.
- **No time window:** you stated none, so `deliver` sends whenever it is called and the wake-up time is up to your scheduler. I added no quiet hours.
- **Dismissals:** `recordDismissal` only counts them and stores the last time. Nothing reads them yet, because you described no rule for them.

If `STATE_DIR` is unset, state goes to `<tmpdir>/bot-state`.
