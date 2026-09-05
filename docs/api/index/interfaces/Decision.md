[**proactive-gate**](../../README.md)

***

[proactive-gate](../../README.md) / [index](../README.md) / Decision

# Interface: Decision

Defined in: [types.ts:111](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L111)

## Properties

### allowed

> **allowed**: `boolean`

Defined in: [types.ts:114](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L114)

***

### candidateId

> **candidateId**: `string`

Defined in: [types.ts:116](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L116)

***

### deferredBy?

> `optional` **deferredBy?**: `string`

Defined in: [types.ts:124](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L124)

The check that deferred, when deferred.

***

### deliverAt?

> `optional` **deliverAt?**: `Date`

Defined in: [types.ts:120](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L120)

Set when a non-rejecting check asked for a later delivery.

***

### evaluatedAt

> **evaluatedAt**: `Date`

Defined in: [types.ts:135](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L135)

***

### id

> **id**: `string`

Defined in: [types.ts:113](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L113)

Unique per evaluation: userId, candidateId, the instant and a sequence number. commit() is idempotent on it.

***

### nearLimit

> **nearLimit**: `object`[]

Defined in: [types.ts:132](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L132)

Budget checks that passed close to their limit.

#### check

> **check**: `string`

#### limit

> **limit**: `number`

#### used

> **used**: `number`

***

### reason?

> `optional` **reason?**: `string`

Defined in: [types.ts:128](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L128)

Human-readable reason, when rejected or deferred.

***

### rejectedBy?

> `optional` **rejectedBy?**: `string`

Defined in: [types.ts:122](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L122)

The check that rejected, when rejected.

***

### retryAt?

> `optional` **retryAt?**: `Date`

Defined in: [types.ts:126](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L126)

When to evaluate again, when deferred.

***

### shadowed

> **shadowed**: `string`[]

Defined in: [types.ts:130](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L130)

Checks in shadow mode that would have rejected or deferred.

***

### surfaces

> **surfaces**: [`Surface`](../type-aliases/Surface.md)[]

Defined in: [types.ts:118](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L118)

Surfaces to route to when allowed. Empty when rejected or deferred.

***

### trace

> **trace**: [`TraceEntry`](TraceEntry.md)[]

Defined in: [types.ts:134](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L134)

Every check that ran, in order, with what it said.

***

### userId

> **userId**: `string`

Defined in: [types.ts:115](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L115)
