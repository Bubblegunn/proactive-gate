`bot.mjs` is written and works. It has no dependencies. I ran it against a fresh `STATE_DIR` and checked these cases:

| Case | Result |
|---|---|
| Normal candidate | Shown on `["push","inApp"]` |
| Same candidate id again | Same answer, nothing spent twice |
| Same finding key under a new id, same day | Held: "already shown today" |
| Fewer than 3 data points | Held |
| `crisis` true | Held |
| `focusMode` true | Shown on `["inApp"]` only |
| Invalid time zone | Held |
| Local hour mostly dismissed | Shown on `["inApp"]` only |

I did not run a restart test or two parallel workers. State uses the kit's atomic file claims, so it should survive a restart and be safe across processes, but I haven't checked that.

**Rules:**
- **Crisis:** nothing is shown on any surface.
- **Time zone:** an unknown or invalid zone holds everything.
- **Weak finding:** held if it has fewer than 3 data points or confidence below 0.6.
- **Repeat finding:** the same `insight.key` is shown at most once per user per local day.
- **Push:** dropped when `focusMode` is on, or when the user's local hour has a high dismiss rate. The in-app item is still shown.
- **Redelivery:** the same candidate id returns the same answer.

**Numbers I chose:**
- Minimum data points: 3.
- Minimum confidence: 0.6.
- Hour counts as bad once there are at least 5 earlier messages and at least 70% were dismissed.
- Repeat suppression lasts until the end of the user's local day. The request gave no length, so I used the default.

**Not enforced:**
- Opt-in and opt-out: the data carries neither, so none is checked.
- Quiet hours and daily caps: the request states none, so I added none.
