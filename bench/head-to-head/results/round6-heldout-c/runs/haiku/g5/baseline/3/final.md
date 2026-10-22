I wrote `bot.mjs` in the working directory. All 34 behavioral checks pass. Nothing is sent, and I did not commit.

**What `check` returns**

| Situation | Result |
|---|---|
| Customer has never written to us | blocked, `no-prior-contact` (both types) |
| Customer sent STOP and has not sent START/UNSTOP since | blocked, `opted-out` (both types) |
| Freeform, last customer message 24 h or more ago | blocked, `freeform-window-closed` |
| Template, customer has written before and has not opted out | allowed |
| Freeform, inside the 24 h window | allowed |
| Unknown `type` | blocked, `unknown-message-type` (fails closed) |

**Choices you may want to change**

- **STOP keywords:** STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, OPTOUT, REVOKE. A match needs the whole message to be the keyword after case, spaces, punctuation and zero-width characters are removed. Full-width letters are folded. "please stop by the store" is not an opt-out.
- **Gap:** a plain request such as "please stop texting me" does not trigger an opt-out. Catching it would also catch ordinary sentences, which you asked me to leave alone. If you want that, it needs a separate rule with its own review.
- **START keywords:** only START and UNSTOP lift an opt-out. I left out YES, so a stray "yes" does not re-subscribe someone. Add it if your policy counts YES as opt-in.
- **Ordering:** a late-arriving START does not undo a newer STOP. Out-of-order inbound timestamps do not shrink the 24 h window.
- **Invalid input:** a non-Date `at` or `now` throws a `TypeError`.

**Testing:** I ran the checks from a temporary directory outside the project. They cover the keyword variants, the ordinary-sentence cases, the window edges, the START/UNSTOP round trip and out-of-order timestamps. The sandbox has Node 24, not 22. The code uses only standard ES features, so it should run on 22 as well, but I did not run it there.
