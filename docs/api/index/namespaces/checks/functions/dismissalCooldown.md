[**proactive-gate**](../../../../README.md)

***

[proactive-gate](../../../../README.md) / [index](../../../README.md) / [checks](../README.md) / dismissalCooldown

# Function: dismissalCooldown()

> **dismissalCooldown**(`options?`): [`Check`](../../../interfaces/Check.md)

Defined in: [checks.ts:169](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/checks.ts#L169)

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

[`Check`](../../../interfaces/Check.md)
