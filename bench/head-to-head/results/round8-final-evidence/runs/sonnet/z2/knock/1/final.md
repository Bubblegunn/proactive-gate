`bot.mjs` is written in the current folder. It has no dependencies, so `package.json` is unchanged. My checks all passed. They ran against a temporary `STATE_DIR` and covered the cases below; nothing was actually sent. The test script is in `/tmp/botcheck`, outside the project.

**How it works**
- **`trySend`** refuses the text, with a plain `reason`, in these cases:
  - **Already sent:** the same `message.id` was already recorded. A redelivery or a crashed-and-retried worker therefore can't double-send.
  - **Opted out:** the customer opted out.
  - **Quiet hours:** it is outside 9:00–20:00 in the customer's own timezone, and on Sundays before 12:00. This is stricter than the federal 8am–9pm rule so it also fits states like TX, FL, OK, WA and MD. Holidays are not checked.
  - **Bad timezone:** the timezone is invalid, so quiet hours can't be checked.
  - **Stale digest:** it was generated more than 48 hours ago.
  - **Too soon:** a different digest already went to this customer in the last 6 days.
  - Otherwise it returns `sent: true` and records the send.
- **`handleInbound`** returns `{ reply }`, which is text the app may send back or `null`. The code never sends anything itself.
  - **Opt-out:** STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, OPTOUT and REVOKE opt the customer out. So do phrases like "stop texting me", "don't text me" and "remove me". Each gets a confirmation reply.
  - **Opt back in:** START or UNSTOP.
  - **Help:** HELP or INFO get a help reply.
  - Any other text gets no reply.
- **`optOut`** records an opt-out from the account page.
- **State:**
  - **Storage:** it is one JSON file per user in `STATE_DIR`, written atomically so it survives restarts.
  - **Locking:** a per-user lock covers the opt-out check, the duplicate check and the record. Twelve parallel processes sent with the same id produced exactly one `sent: true`. An opt-out can't slip in between the check and the record.
  - **Corrupt files:** a corrupt state file throws instead of letting a text through.

**What you need to handle**
- **Consent:** the app gives me no record of consent. TCPA requires prior express written consent for marketing texts, and a weekly digest probably counts as marketing even if the customer only agreed to reminders. The code can't check this. Confirm that you hold consent for the digest specifically, and add a consent check in front of `trySend` if you have the data.
- **Message body:** I never see the body. Each digest should name your brand and say "Reply STOP to unsubscribe, HELP for help. Msg&data rates may apply."
- **Replies:** send the `reply` from `handleInbound` back to the customer, especially the STOP confirmation.
