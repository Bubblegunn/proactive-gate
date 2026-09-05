[**proactive-gate**](../../../../README.md)

***

[proactive-gate](../../../../README.md) / [index](../../../README.md) / [checks](../README.md) / boundedDeferral

# Function: boundedDeferral()

> **boundedDeferral**(`options?`): [`Check`](../../../interfaces/Check.md)

Defined in: [checks.ts:315](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/checks.ts#L315)

Bounded deferral (Horvitz): when the user is busy, wait t* = min(bound,
lambda * interruptCost / (2 * staleness)), the optimum of a quadratic
staleness loss against the cost of interrupting a busy person, with the
user becoming free at rate lambda. Never rejects; only moves deliverAt.

## Parameters

### options?

#### boundSeconds?

`number`

#### interruptCost?

`number`

#### isBusy?

(`ctx`) => `boolean`

#### lambda?

`number`

#### staleness?

`number`

## Returns

[`Check`](../../../interfaces/Check.md)
