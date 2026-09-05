[**proactive-gate**](../../../../README.md)

***

[proactive-gate](../../../../README.md) / [checks](../README.md) / dismissalCooldown

# Function: dismissalCooldown()

> **dismissalCooldown**(`options?`): [`Check`](../../../../interfaces/Check.md)

Defined in: [checks.ts:164](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/checks.ts#L164)

When the user has dismissed `dismissals` candidates of a type within
`withinDays`, that type stays silent for `silenceDays`. Fed by
gate.record(userId, candidate, "dismissed").

## Parameters

### options?

#### dismissals?

`number`

#### silenceDays?

`number`

#### withinDays?

`number`

## Returns

[`Check`](../../../../interfaces/Check.md)
