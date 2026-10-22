# proactive-gate guide

The full guide behind `SKILL.md`: the policy format, the decision loop, stores, inbound STOP, legal presets and replay. Read the step it names before you change that part of the integration.

Put a gate in front of every message your agent sends on its own initiative. The gate decides whether the message may go now, from the user's consent, time zone, quiet hours, snooze, budgets and inbound opt-outs. It never sends anything. When it refuses, it names the check that refused, says why, and gives the earliest time to ask again when it can.

## When to use it

- You are adding a reminder, nudge, digest, alert or follow-up that the user did not just ask for.
- The user asks for quiet hours, a message limit, a pause, consent checks, or opt-out handling.
- A message leaves from a loop, a schedule or a webhook instead of as the answer to a request.

Do not use it for a reply to something the user just wrote.

## Step 1: check Node, then install

1. Run `node -v`. If the major version is below 22, stop and tell the user that proactive-gate needs Node 22 or newer. Do not run `npm install proactive-gate` on an older Node: npm then installs 0.7.3, an older package with a different API, and does not warn you. Python users run `pip install proactive-gate` (Python 3.11 or newer).
2. If package.json already lists proactive-gate, run `npm install`. Otherwise run `npm install proactive-gate`.
3. Check that the installed package has what this skill uses:

```bash
node -e "import('proactive-gate').then(m => { const g = m.createGate({ policy: { specVersion: '1.0.0', checks: [{ id: 'consent' }] }, store: new m.MemoryStore() }); console.log(typeof g.whenAllowed, typeof g.inbound?.handle) })"
```

It must print: function function. If it prints undefined, the installed version predates `gate.whenAllowed`, `gate.inbound` and the `inboundConsent` option, which arrived after 0.9.0 and are expected in 0.10.0. Run `npm ls proactive-gate`, tell the user to upgrade to the newest release, and do not replace these calls with hand-written code or an older API.


## Ten-line integration

One command writes the policy file. `--minimal` writes the short policy in Step 2 instead of the longer default; --legal us appends the US calling-hours preset (usTcpa).

```bash
npx proactive-gate init --minimal --legal us
```

Then this code, in an ES module on Node 22 or newer:

```javascript
import { readFileSync } from "node:fs";
import { createGate, SqliteStore, explain } from "proactive-gate";
const gate = createGate({ policy: JSON.parse(readFileSync("proactive-gate.policy.json", "utf8")), store: new SqliteStore("state.db") });
export async function decide(user, candidate) {
  const input = { user, candidate, now: new Date() };
  const decision = await gate.evaluate(input);
  const allowed = decision.allowed && (await gate.commit(decision, input));
  return { allowed, nextAllowedAt: decision.nextAllowedAt, summary: explain(decision).summary };
}
```

Send only when `allowed` is true; if it is false and `nextAllowedAt` is set, hold the message until then.

## Step 2: a working policy

Save this as `proactive-gate.policy.json`. It runs consent, dedupe, snooze (defer instead of refuse), quiet hours, and a limit of 3 messages per user per day. `npx proactive-gate init --minimal` writes the same file.

```json
{
  "specVersion": "1.0.0",
  "checks": [
    { "id": "consent" },
    { "id": "dedupe", "windowSeconds": 86400 },
    { "id": "snooze", "defer": true },
    { "id": "quietHours" },
    { "id": "dailyBudget", "limit": 3 }
  ]
}
```

dedupe sits second on purpose. Commit spends budget units in policy order and stops at the first check that refuses. With dedupe after dailyBudget, a duplicate delivery spends a budget unit before its claim fails, so one message is counted twice. Keep dedupe before the budgets.

To add the other budget periods and a per-channel limit, add these checks to the same list:

```json
{
  "specVersion": "1.0.0",
  "checks": [
    { "id": "weeklyBudget", "limit": 10 },
    { "id": "monthlyBudget", "limit": 30 },
    { "id": "rateLimit", "limit": 5, "perSeconds": 3600, "keyBy": "channel" }
  ]
}
```

Daily, weekly and monthly budget refusals carry the exact next reset in `decision.nextAllowedAt`, computed in the user's time zone. A `rateLimit` refusal carries none. `keyBy` is "user" or "channel" and sets what the rate limit counts per.

## Step 3: choose a store

| Situation | Store |
|---|---|
| One process, and losing state on restart is acceptable | `MemoryStore` (forgets everything on restart; tests and demos only) |
| Several processes on one machine | `SqliteStore("state.db")` |
| Several machines | `RedisStore` or `PostgresStore` |

All processes must share one store and the same `keyPrefix` (default "pg:"). A separate store per process gives every process its own budget. `onStoreError` decides what happens when the store is down: "open" lets a message through, "closed" refuses it.

## Step 4: the decision loop

```js
const candidate = { id: "reminder:" + order.id, type: "reminder", channel: "sms", dedupeKey: "order:" + order.id + ":shipped" };
const input = { user, candidate, now: new Date() };
const decision = await gate.evaluate(input);
if (decision.allowed) {
  if (await gate.commit(decision, input)) {
    await send(candidate, decision.surfaces);
  } else {
    // Another worker took the last budget unit, or delivered the same event. Evaluate again.
    const retry = await gate.evaluate({ ...input, now: new Date() });
    if (retry.nextAllowedAt) hold(candidate, retry.nextAllowedAt);
    else log(retry.rejectedBy, retry.reason);
  }
} else if (decision.nextAllowedAt) {
  hold(candidate, decision.nextAllowedAt);
} else {
  log(decision.rejectedBy, decision.reason);
}
```

`evaluate` reads the budgets and spends nothing. `commit` spends one unit of each budget and returns false if another worker took the last one, so send only when it returns true.

Rules for this loop:

- (a) `candidate.id` names the message in traces and logs. Decision ids are unique per evaluation, so a reused id does not hide a budget unit. Still give each message its own id.
- (b) For a message that can be redelivered (a webhook, or a queue with retries), set `candidate.dedupeKey` to the event's identity, for example order:42:shipped. Never use a fresh uuid per attempt. Keep the `dedupe` check: with it, the event is delivered at most once, even across workers.
- (c) Call `commit` before sending, and send only when it returns true. `commit` is idempotent: asking again for the same decision returns the first answer and spends nothing more. A crash between `commit` and the send loses one message and keeps its budget unit.
- (d) Hold a refused message until `decision.nextAllowedAt`, then evaluate again. That time is a lower bound: another check can still refuse at that instant. No `nextAllowedAt` means do not retry: consent, dedupe and inboundConsent refusals carry none, so the loop logs them.
- (e) `await gate.whenAllowed(input)` returns an object with two fields, at and decision: the earliest instant the message could go out when several checks refuse in turn, for example a full daily budget plus quiet hours. It spends nothing. Use it to answer "when can this be sent?". If at is null, no instant was found within the hop limit (default 12), and decision is the last refusal.

## What goes in

- The user needs `id` and `consent`. Quiet hours need `timezone` and `quietHours` with `start` and `end` as "HH:MM". Without a time zone the check skips and says so in the trace, so the message is allowed and may go out at night.
- The candidate needs `id` and `type`. `priority` is one of low, normal, high or critical. `channel` names where it goes, and rate limits keyed by channel read it.
- Never set `consent` to true on the user's behalf. It records what the person agreed to. Take the time zone from the person's profile. Do not guess it.

## What comes out

- `decision.allowed` is the answer. When it is false, `decision.rejectedBy` names the check and `decision.reason` says why.
- `decision.nextAllowedAt` is the earliest time the refusing check would stop refusing: the end of quiet hours, the end of a snooze, the next budget reset, the opening of a legal window, or the end of a windowed consent.
- `explain(decision).summary` is one plain sentence for the person or a log.

## Which names to use

| You want | Use | Do not use |
|---|---|---|
| The check that refused a legal window | `rejectedBy` is `window:tcpa` for `{ "preset": "usTcpa" }` | `rejectedBy` set to `usTcpa` |
| When a refused message may go out | `decision.nextAllowedAt` | holdUntil (no such field) |
| When a deferred message is retried | `decision.retryAt`, the same value as `decision.nextAllowedAt` | any other field name |
| The user's snooze end | `user.snoozedUntil` | any other field name |
| The time zone for quiet hours and legal windows | `user.timezone` | no zone: the check skips and the message is allowed |

```js
const user = { id: "u1", consent: true, timezone: "Europe/Istanbul", quietHours: { start: "22:00", end: "08:00" }, snoozedUntil: "2026-10-22T00:00:00Z" };
```

## Check ids the guide does not describe

Each line names a check id and says in one line what it decides. The full catalogue, with its options, is in `references/checks.md`.

- `killSwitch`: refuses every candidate while the engine kill switch is on, or while a named runtime flag is exactly `false`.
- `enabled`: refuses every candidate for a user whose `proactiveEnabled` is `false`.
- `mode`: refuses a user whose `mode` is not in the check's `allow` list (default `normal`).
- `mute`: refuses a candidate whose type the user has muted.
- `intensity`: refuses candidates below the priority floor of the user's intensity setting.
- `trustRamp`: for a set number of days after `user.createdAt`, refuses candidates below a minimum priority; requested and commitment candidates pass.
- `dismissalCooldown`: after repeated dismissals in a window, silences that candidate type for a set time; the types it is told to exempt are never silenced.
- `adaptiveTiming`: lets the caller move delivery to a later moment; it does not refuse on its own.
- `utilityFloor`: refuses a candidate whose `pAccept` is below the threshold set by the false-alarm and missed-help costs.
- `boundedDeferral`: delays delivery while the caller says the user is busy, by at most `boundSeconds`.
- `allowedWindow`: refuses a candidate outside a daily window in the user's zone.
- `requiresConsent`: refuses a candidate that needs a named consent the user has not given.
- `recentInteraction`: refuses a candidate unless the user wrote to the assistant within the last hours.
- `windowBudget`: caps messages per user within a window that starts at the user's last inbound message.
- `freshness`: refuses content at or after its `freshUntil`, or older than `maxAgeSeconds` by its `createdAt`.
- `crisisQuiet`: refuses every candidate but support messages while `user.crisisUntil` is in the future.
- `deadHours`: removes push for a candidate in an hour when the user rarely acts on messages, and never refuses.

## Opt-out keywords (inbound STOP and START)

Turn the check on, then pass every inbound reply to the gate:

```ts
const gate = createGate({ policy, store, inboundConsent: true });

// In the webhook that receives replies from users:
const result = await gate.inbound.handle({ userId, channel: "sms", text: body });
```

Set the `inboundConsent` option to true to add the check right after `consent`. The `handle` method of `gate.inbound` writes to the gate's own store under its key prefix, so the check reads what `handle` wrote. Set `channel` on each candidate ("sms", "email", and so on); the check reads it, else the first surface, else "default".

- Matching: the whole message only, ignoring case, surrounding spaces and trailing punctuation. STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, REVOKE and OPT OUT (also OPT-OUT, OPTOUT) switch the channel off; START, UNSTOP and YES switch it on. "stop it" is not a keyword. A stop on one channel does not silence another.
- The state persists in the store. A `MemoryStore` forgets stops on restart, and then the gate messages people who replied STOP. Use `SqliteStore`, `RedisStore` or `PostgresStore` in production.
- Where consent is legally required, set `onStoreError` to "closed". `handle` does not catch store errors, so answer the carrier with a non-200 status and let it retry.
- Do not set `user.consent` from an inbound message. The store keeps the STOP and START state.

## Legal and platform limits

A preset is a reviewed list of checks with its sources, for example `{ "preset": "usTcpa" }`. Read `presets.usTcpa.note` before you use it: it says what the preset covers and what it leaves out. A preset is not legal advice.

- A refusal under a preset sets `decision.rejectedBy` to the check that refused, for example `window:tcpa`.

Print every preset with its sources:

```bash
node -e "import('proactive-gate').then(m => { for (const [k, p] of Object.entries(m.presets)) console.log(k, p.sources.join(' ')) })"
```

## How would last week look under this policy

A log holds one JSON object per line, with user, candidate and now, in time order:

```jsonl
{"user":{"id":"ayse","consent":true,"timezone":"Europe/Istanbul","quietHours":{"start":"22:00","end":"08:00"}},"candidate":{"id":"c1","type":"nudge"},"now":"2026-09-07T01:29:00.000Z"}
```

1. No log yet? `npx proactive-gate simulate --dump-events week.jsonl` writes a sample week to start from.
2. `npx proactive-gate simulate week.jsonl --policy current.json --policy proposed.json --disagreements --why` prints only the candidates the two policies treat differently, one sentence each, then totals.
3. `npx proactive-gate simulate week.jsonl --policy policy.json` runs one policy against no gate, so the output shows what that policy would stop.
4. `npx proactive-gate replay week.jsonl --policy policy.json --commit` runs one policy and spends budgets in order. Without `--commit`, dailyBudget never refuses, so the allowed count is too high. `simulate` always spends budgets.
5. Run the command and show the user its counts. Do not estimate the counts by reading the log.

To replay in code, run the same loop as a function body. It needs `createGate`, `MemoryStore`, a `policy` and the `events` read from the log:

```js
// in-code replay: one policy, one fresh store, events in time order
const gate = createGate({ policy, store: new MemoryStore() });
const sorted = events.slice().sort((a, b) => new Date(a.now) - new Date(b.now));
let allowed = 0;
for (const event of sorted) {
  const input = { user: event.user, candidate: event.candidate, now: new Date(event.now) };
  const decision = await gate.evaluate(input);
  if (decision.allowed && (await gate.commit(decision, input))) allowed += 1;
}
return allowed;
```

Use a fresh store for each run. The output reports what the policy would have decided, not what a recipient did, and a log an earlier policy filtered gives an illustration, not an estimate.

## From a coding agent

`npx proactive-gate mcp --policy proactive-gate.policy.json` serves the gate over MCP with two tools, `decide` and `explain`. In Claude Code:

```
claude mcp add proactive-gate -- npx proactive-gate mcp --policy proactive-gate.policy.json
```

Call `decide` with `commit` set to true on the call you act on. If another delivery takes the last budget unit between `decide` and the commit, the answer comes back as a refusal with the rejecting check named `commit`, so do not send.
