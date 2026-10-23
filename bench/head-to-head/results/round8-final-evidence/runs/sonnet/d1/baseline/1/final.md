`bot.mjs` is written, and its 13 tests in `bot.test.mjs` pass (`node --test bot.test.mjs`). Nothing is sent; the function only returns a decision. It never reads the clock and doesn't throw on bad input.

**Rules, checked in this order (the first failure is returned):**

| `rule` | Held when |
|---|---|
| `invalid-input` | `user` or `message` is missing or malformed, `text` is empty, or something unexpected threw |
| `opted-out` | `optedOutAt` is anything other than null or undefined. This holds both kinds, including unparseable or future-dated values. |
| `no-consent` | The text is marketing and `optedIn` isn't exactly `true` |
| `missing-opt-out-text` | The text is marketing and doesn't contain "STOP" (CTIA opt-out instruction) |
| `unknown-time-zone` | The text is marketing and `timeZone` is null, invalid, or a placeholder such as `UTC`, `Etc/*` or a fixed offset |
| `invalid-time` | The text is marketing and `now` isn't a valid Date |
| `quiet-hours` | The text is marketing and the customer's local time is outside the window |

**Sending window for marketing:**
- The window is 9:00 to 20:00 in the customer's own time zone, and Sunday is 12:00 to 20:00.
- The FCC rule allows 8:00 to 21:00. I used a narrower window because some states stop at 8 pm (FL, MD, OK, WA) and Texas restricts Sunday mornings.
- That window also fits India and Japan.
- The tests cover daylight-saving changes and the same moment in Chicago, Tokyo and Kolkata.

**Transactional texts** skip the time window and the opt-in check. A login code at 3 am goes through.

**Decisions to confirm:**
- **Mislabelled promos:** A text labelled `transactional` that contains promo wording (such as "20% off", "use code", "sale") is treated as marketing. FCC rules treat mixed texts as telemarketing. A `kind` that isn't exactly "transactional" is also marketing, as you defined it. The promo check is a keyword list, so it will miss some promos and could flag some real order texts.
- **Unknown time zone:** Marketing is held rather than guessed, since we can't tell whether it's a legal hour.
- **STOP blocks transactional too:** After a STOP, login codes and shipping notices are held as well, following the CTIA reading that STOP ends all messages. This may block a code the customer asks for later. If you want those allowed, it's a small change.
- **Transactional without opt-in:** I allow it, on the basis that the customer gave their number for that order. Say so if `optedIn: false` should mean no texts at all.
- **Re-opt-in:** If a customer opts back in after a STOP, `optedOutAt` must be cleared on your side. I can't tell which happened first from the two fields.

**Not checked:** sender name in the message, India's DND registry and template registration, and prohibited content categories.
