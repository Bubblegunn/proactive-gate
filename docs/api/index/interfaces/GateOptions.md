[**proactive-gate**](../../README.md)

***

[proactive-gate](../../README.md) / [index](../README.md) / GateOptions

# Interface: GateOptions

Defined in: [types.ts:162](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L162)

## Properties

### checks

> **checks**: [`Check`](Check.md)[]

Defined in: [types.ts:163](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L163)

***

### hooks?

> `optional` **hooks?**: [`GateHooks`](GateHooks.md)

Defined in: [types.ts:176](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L176)

Observation hooks, e.g. one OpenTelemetry span per check.

***

### keyPrefix?

> `optional` **keyPrefix?**: `string`

Defined in: [types.ts:174](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L174)

Key prefix for everything the gate writes to the store.

***

### onDecision?

> `optional` **onDecision?**: (`decision`) => `void`

Defined in: [types.ts:172](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L172)

Receives every decision. Wire this to your logger.

#### Parameters

##### decision

[`Decision`](Decision.md)

#### Returns

`void`

***

### onStoreError?

> `optional` **onStoreError?**: `"open"` \| `"closed"`

Defined in: [types.ts:170](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L170)

What to do when a store-backed check throws. "open" lets the candidate
through and records the failure in the trace; "closed" rejects.
Default "open": a Redis outage should not silence every user.

***

### store?

> `optional` **store?**: [`Store`](Store.md)

Defined in: [types.ts:164](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L164)
