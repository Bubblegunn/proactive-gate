[**proactive-gate**](../../../../README.md)

***

[proactive-gate](../../../../README.md) / [checks](../README.md) / BudgetCheck

# Interface: BudgetCheck

Defined in: [checks.ts:217](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/checks.ts#L217)

At most `limit` deliveries per user per local day. The check reads the
counter; gate.commit() increments it atomically and can still refuse when
two instances race, which is the only race-safe place to enforce a cap.

## Extends

- [`Check`](../../../../interfaces/Check.md)

## Properties

### id

> **id**: `string`

Defined in: [types.ts:71](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L71)

#### Inherited from

[`Check`](../../../../interfaces/Check.md).[`id`](../../../../interfaces/Check.md#id)

***

### limit

> **limit**: `number`

Defined in: [checks.ts:218](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/checks.ts#L218)

***

### nonRejecting?

> `optional` **nonRejecting?**: `boolean`

Defined in: [types.ts:73](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L73)

True when the check can never reject; it only adjusts timing or surfaces.

#### Inherited from

[`Check`](../../../../interfaces/Check.md).[`nonRejecting`](../../../../interfaces/Check.md#nonrejecting)

## Methods

### run()

> **run**(`ctx`): [`CheckOutcome`](../../../../type-aliases/CheckOutcome.md) \| `Promise`\<[`CheckOutcome`](../../../../type-aliases/CheckOutcome.md)\>

Defined in: [types.ts:74](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L74)

#### Parameters

##### ctx

[`CheckContext`](../../../../interfaces/CheckContext.md)

#### Returns

[`CheckOutcome`](../../../../type-aliases/CheckOutcome.md) \| `Promise`\<[`CheckOutcome`](../../../../type-aliases/CheckOutcome.md)\>

#### Inherited from

[`Check`](../../../../interfaces/Check.md).[`run`](../../../../interfaces/Check.md#run)
