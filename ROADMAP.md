# Roadmap

This file used to be a list of things to add. It is now a list of one thing, because the library
grew a week's worth of surface in a week and the honest next step is not a feature.

## The one open invitation

- **An implementation of `spec/` in another language, by somebody who is not us.** Go, Rust,
  Swift, Kotlin, anything. [`spec/CONFORMANCE.md`](spec/CONFORMANCE.md) states what passing means
  and what an implementation may leave out, and issue
  [#16](https://github.com/Bubblegunn/proactive-gate/issues/16) is the place to say you are doing
  it. The sentence this earns cannot be earned any other way: the TypeScript, the Python and an
  independently implemented third version all conform to the same behavioural specification.

## What is deliberately closed

Not because these are bad ideas. Because the project's constraint is no longer functionality.

- **New presets.** Frozen at what is merged. A new one needs someone who is shipping to that
  channel or under that instrument and says so on the issue. Every country has a law; a preset
  nobody ships against rots unread, and a rotted preset is worse than a missing one.
- **New adapters and new stores.** Same rule: the next one arrives with the person who needs it,
  not ahead of them.
- **A thirteenth check.** It needs a deployment whose rule the twelve cannot express.

## What counts as progress instead

- **Evidence a stranger can run.** `npx proactive-gate simulate` is the first of it: one week, two
  policies, what each one delivered and what it held and why. The next step in that direction is a
  figure, not a feature.
- **Somebody using it in production and saying so.** One of those is worth more here than any
  number of presets, and it is the thing this repository cannot manufacture for itself.

Things that will never be here: anything that needs a server, a hosted account, or reads the content
of a message.
