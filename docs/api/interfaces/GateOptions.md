[**proactive-gate**](../README.md)

***

[proactive-gate](../README.md) / GateOptions

# Interface: GateOptions

Defined in: [types.ts:117](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L117)

## Properties

### checks

> **checks**: [`Check`](Check.md)[]

Defined in: [types.ts:118](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L118)

***

### keyPrefix?

> `optional` **keyPrefix?**: `string`

Defined in: [types.ts:129](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L129)

Key prefix for everything the gate writes to the store.

***

### onDecision?

> `optional` **onDecision?**: (`decision`) => `void`

Defined in: [types.ts:127](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L127)

Receives every decision. Wire this to your logger.

#### Parameters

##### decision

[`Decision`](Decision.md)

#### Returns

`void`

***

### onStoreError?

> `optional` **onStoreError?**: `"open"` \| `"closed"`

Defined in: [types.ts:125](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L125)

What to do when a store-backed check throws. "open" lets the candidate
through and records the failure in the trace; "closed" rejects.
Default "open": a Redis outage should not silence every user.

***

### store?

> `optional` **store?**: [`Store`](Store.md)

Defined in: [types.ts:119](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L119)
