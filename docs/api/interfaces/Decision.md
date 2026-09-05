[**proactive-gate**](../README.md)

***

[proactive-gate](../README.md) / Decision

# Interface: Decision

Defined in: [types.ts:84](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L84)

## Properties

### allowed

> **allowed**: `boolean`

Defined in: [types.ts:85](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L85)

***

### candidateId

> **candidateId**: `string`

Defined in: [types.ts:87](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L87)

***

### deliverAt?

> `optional` **deliverAt?**: `Date`

Defined in: [types.ts:91](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L91)

Set when a non-rejecting check asked for a later delivery.

***

### evaluatedAt

> **evaluatedAt**: `Date`

Defined in: [types.ts:98](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L98)

***

### reason?

> `optional` **reason?**: `string`

Defined in: [types.ts:95](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L95)

Human-readable reason, when rejected.

***

### rejectedBy?

> `optional` **rejectedBy?**: `string`

Defined in: [types.ts:93](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L93)

The check that rejected, when rejected.

***

### surfaces

> **surfaces**: [`Surface`](../type-aliases/Surface.md)[]

Defined in: [types.ts:89](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L89)

Surfaces to route to when allowed. Empty when rejected.

***

### trace

> **trace**: [`TraceEntry`](TraceEntry.md)[]

Defined in: [types.ts:97](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L97)

Every check that ran, in order, with what it said.

***

### userId

> **userId**: `string`

Defined in: [types.ts:86](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L86)
