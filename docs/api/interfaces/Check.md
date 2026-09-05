[**proactive-gate**](../README.md)

***

[proactive-gate](../README.md) / Check

# Interface: Check

Defined in: [types.ts:70](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L70)

## Extended by

- [`BudgetCheck`](../proactive-gate/namespaces/checks/interfaces/BudgetCheck.md)

## Properties

### id

> **id**: `string`

Defined in: [types.ts:71](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L71)

***

### nonRejecting?

> `optional` **nonRejecting?**: `boolean`

Defined in: [types.ts:73](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L73)

True when the check can never reject; it only adjusts timing or surfaces.

## Methods

### run()

> **run**(`ctx`): [`CheckOutcome`](../type-aliases/CheckOutcome.md) \| `Promise`\<[`CheckOutcome`](../type-aliases/CheckOutcome.md)\>

Defined in: [types.ts:74](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L74)

#### Parameters

##### ctx

[`CheckContext`](CheckContext.md)

#### Returns

[`CheckOutcome`](../type-aliases/CheckOutcome.md) \| `Promise`\<[`CheckOutcome`](../type-aliases/CheckOutcome.md)\>
