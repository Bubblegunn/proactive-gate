`bot.mjs` is written in the current folder. It exports `deliver` and `recordDismissal`, with the gate kit appended. I wrote it inline and didn't use the library, so there's no dependency to install.

I checked it with a script against a temporary `STATE_DIR`:
- **Normal send:** at 08:00 local, both push and in-app go out.
- **Redelivery:** the same id sent twice makes one push and one in-app item, and the second call reports the same result.
- **Quiet hours:** at 04:00 local, only the in-app item goes out, and `resumeAt` is 07:00 local.
- **Snooze:** only the in-app item goes out, and `resumeAt` is `snoozedUntil`.
- **Category off:** `categories.briefing === false` sends nothing.
- **Consent store down:** the consent store throwing sends nothing.
- **Concurrency:** four parallel calls with one id made exactly one push.

I did not check these cases:
- restart survival
- multi-process concurrency (the test used one process)
- a push that returns false
- a push that throws
- an invalid time zone
- a `notificationsPermitted: false` user

**Behaviour**
- **Category switch:** `categories[type] === false` withholds everything, push and in-app. A missing category or missing `categories` counts as never asked, so it is allowed.
- **Consent:** the consent key is `candidate.type`, because you gave no purpose names. A missing or false value withholds everything. If `consentStore.get` throws, nothing is sent and `reason` says consent couldn't be checked.
- **Push-only holds:** these stop the push but still add the silent in-app item. They are `notificationsPermitted === false`, an active snooze, an unknown or invalid time zone, and quiet hours. `reason` and `resumeAt` come back for each, with a local clock time and zone name in the text when there is one. `resumeAt` is null for an OS-permission block or an invalid zone.
- **Redelivery:** the push and the in-app item are each claimed once per user and message id.
  - A push that returns false releases its claim, so a later retry can send it.
  - A push that throws keeps its claim, so it is never sent twice.
- **`recordDismissal`:** it stores a per-user, per-type count and the last time. Nothing reads it yet, because you didn't state a dismissal rule.

**Numbers I chose**
- Quiet hours for push are 22:00 to before 07:00 in the user's local time. You asked for a push "at wake-up time" but gave no window, so this is my choice.
- There is no daily cap.

**Not enforced:** a briefing-per-day limit and any check on the message body. You didn't ask for either.
