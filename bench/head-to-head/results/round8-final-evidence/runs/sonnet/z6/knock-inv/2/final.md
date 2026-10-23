`bot.mjs` is written and `node check.mjs` passes ("ALL OK").

The check covers:
- consent, and the exact edges of quiet hours (22:00 blocked, 08:00 allowed)
- the cap resetting at local midnight, in two timezones
- the Europe/Berlin daylight-saving change
- `whyNotReceived` output, including `to` being exclusive
- six worker processes making 30 decisions for one user, which gave exactly 3 sends
- a fresh process still seeing those 3 sends
- `dryRun` giving correct counts without creating any state files

I haven't re-read `check.mjs` since the notice that it changed on disk, so the pass was against the version I ran.

**How it works**
- **Rules:** checked in this order: consent, quiet hours (22:00 to 08:00 local), then the 3-per-day cap. Blocked notifications don't count toward the cap. The cap uses the user's local calendar day, computed with `Intl`, so no dependency was needed and `package.json` is unchanged.
- **Rule codes:** `NO_CONSENT`, `QUIET_HOURS`, `DAILY_CAP`. I added `INVALID_TIMEZONE`, which blocks when the timezone is missing or unrecognised.
- **State:** each user has an append-only log under `STATE_DIR/users/`, written under a per-user lock so several workers can run at once. A lock left by a crashed worker is cleared after 10 seconds.
- **Support:** `whyNotReceived` reads that log. Each entry has a plain-language `text` and an `availableAt`.
  - Quiet hours: `availableAt` is the next 08:00 local.
  - Daily cap: `availableAt` is the next local midnight, or 08:00 if midnight is still inside quiet hours.
  - No consent: `availableAt` is `null`.
- **Policy testing:** `dryRun` replays the events in time order, in memory only. It reads and writes nothing in `STATE_DIR`, and it still requires consent.

**Choices I made where the spec was silent**
- Only `consent === true` counts as consent.
- If `quietHours.start` equals `quietHours.end`, the window is treated as empty.
- If `dailyCap` is 0, everything is blocked; if it's `null`, there is no cap.
- A repeated `notification.id` is not de-duplicated. Each call is its own decision, so a retry of a delivered notification would count and send again.

`check.mjs` is a test script I added; delete it if you don't want it in the folder.
