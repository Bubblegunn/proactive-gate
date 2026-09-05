[**proactive-gate**](../../../../README.md)

***

[proactive-gate](../../../../README.md) / [index](../../../README.md) / [checks](../README.md) / snooze

# Function: snooze()

> **snooze**(`options?`): [`Check`](../../../interfaces/Check.md)

Defined in: [checks.ts:91](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/checks.ts#L91)

A global pause until an instant. With `defer: true` the decision carries the instant as `retryAt` instead of rejecting.

## Parameters

### options?

#### defer?

`boolean`

## Returns

[`Check`](../../../interfaces/Check.md)
