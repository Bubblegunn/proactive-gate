# Vercel AI SDK: where proactive-gate can be listed

Not posted. Efe approves before anything is opened. Checked against `vercel/ai` on
5 September 2026.

## What exists, and what does not

- `content/providers/05-community-providers/` is the community section of the docs, and it is
  for model providers built on the Language Model Specification (`01-custom-providers.mdx`
  says so). proactive-gate is not a provider; a pull request there would be off target.
- `content/providers/06-adapters/` lists adapters for `useChat` and `useCompletion` (LangChain,
  LlamaIndex). Also not this.
- The page proactive-gate belongs next to is
  `content/docs/03-agents/06-tool-approvals.mdx`. Its closing "Related APIs" list already
  points at the first-party policy package (`@ai-sdk/policy-opa`, `06-policy-tool-approvals.mdx`).
  A one-line community pointer there is a maintainer's call; `CONTRIBUTING.md` welcomes
  "community-maintained examples, integrations", asks for signed commits, and says the
  project is moving toward automated maintenance. Odds are modest; the cost is one line.
- The forum is `community.vercel.com` (the `vercel.community` host redirects there), with an
  `ai-sdk` category. No GitHub Discussions on `vercel/ai`.

Two texts follow: the docs line, and the forum post.

## 1. Docs pull request (one line)

File: `content/docs/03-agents/06-tool-approvals.mdx`, section `## Related APIs`, appended as
the last bullet:

```md
- Answer approval requests with a delivery policy (consent, quiet hours, trust ramp, budgets, legal windows) using the community package [proactive-gate](https://github.com/Bubblegunn/proactive-gate) (`proactive-gate/ai-sdk`).
```

Title: `docs(agents): community pointer for policy-driven approvals of proactive sends`

Body:

> Adds one bullet to the Related APIs list on the tool-approvals page for
> [proactive-gate](https://github.com/Bubblegunn/proactive-gate), an MIT package whose
> `proactive-gate/ai-sdk` subpath answers `needsApproval` requests from a delivery policy:
> consent, quiet hours in the user's time zone, a trust ramp for new users, daily and weekly
> budgets consumed at approval time, and platform or legal presets (for example the TCPA
> calling window). A denied call carries the gate's reason, so the model can plan around it.
>
> It sits entirely on the public tool-approval flow, the way the OPA policy package does,
> and installs nothing beyond itself (typed against the call shape, not against `ai`). If a
> community pointer does not belong on this page, close freely; I will not reopen.

## 2. Forum post, `community.vercel.com`, category AI SDK

Title: `proactive-gate: answering tool approvals from a delivery policy (quiet hours, budgets, TCPA)`

> If your agent can message people on its own (reminders, insights, follow-ups), the
> approval step is where "should this go out right now" gets decided. I kept writing that
> decision by hand: quiet hours in the user's time zone, a budget per day, a softer start for
> new users, and the legal windows for SMS.
>
> proactive-gate is that decision as a package. With the AI SDK it answers `needsApproval`:
>
> ```ts
> import { gateToolApproval } from "proactive-gate/ai-sdk";
> const approve = gateToolApproval({ gate, toInput: (call) => ({ user, candidate: fromCall(call) }) });
> const { approved, reason } = await approve(call);
> // addToolApprovalResponse({ id: call.approvalId, approved, reason })
> ```
>
> A denied call carries the reason ("rejected by quietHours: quiet hours 22:00 to 07:00
> America/Chicago; priority normal is below the floor (high)"), the budget is consumed at
> approval time so two instances cannot both send the last message, and the policy can be a
> JSON file you review in a pull request. Fourteen presets ship with their sources (LINE,
> WeChat, Kakao, TCPA, ePrivacy, Telegram, Slack).
>
> `examples/ai-sdk/run.mjs` in the repo runs a day of approval requests offline, no model
> key, and prints which check said no to each. One of them is a critical alert at 23:00 that
> the TCPA preset still refuses, because legal windows carry no priority bypass.
>
> Repo: https://github.com/Bubblegunn/proactive-gate. Docs and a playground:
> https://bubblegunn.github.io/proactive-gate/. It is one week old; the presets are
> reviewable defaults, not legal advice. What is missing for your case?

## Before opening either

1. Efe's approval, and the `v0.2.0` tag on npm so `proactive-gate/ai-sdk` resolves for
   anyone who tries it the same hour.
2. For the docs PR: fork, one signed commit, `pnpm prettier` on the file.
3. Record in `Open-Source-Contributions/Evidence/launch-metrics.md` as
   `INTEGRATION_DOCS_PR_OPENED` or `FORUM_POST`; neither is a contribution until merged.
