[**proactive-gate**](../../README.md)

***

[proactive-gate](../../README.md) / [index](../README.md) / Check

# Interface: Check

Defined in: [types.ts:87](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L87)

## Extended by

- [`BudgetCheck`](../namespaces/checks/interfaces/BudgetCheck.md)

## Properties

### id

> **id**: `string`

Defined in: [types.ts:88](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L88)

***

### nonRejecting?

> `optional` **nonRejecting?**: `boolean`

Defined in: [types.ts:90](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L90)

True when the check can never reject; it only adjusts timing or surfaces.

***

### shadow?

> `optional` **shadow?**: `boolean`

Defined in: [types.ts:92](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L92)

True to record what the check would have done without letting it stop evaluation.

## Methods

### consume()?

> `optional` **consume**(`ctx`): `Promise`\<`boolean`\>

Defined in: [types.ts:99](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L99)

Budget-like checks consume one unit at commit time. Return false when the
unit was not available (a concurrent delivery took it). The gate calls
consume() in check order, once per decision.

#### Parameters

##### ctx

[`CheckContext`](CheckContext.md)

#### Returns

`Promise`\<`boolean`\>

***

### run()

> **run**(`ctx`): [`CheckOutcome`](../type-aliases/CheckOutcome.md) \| `Promise`\<[`CheckOutcome`](../type-aliases/CheckOutcome.md)\>

Defined in: [types.ts:93](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L93)

#### Parameters

##### ctx

[`CheckContext`](CheckContext.md)

#### Returns

[`CheckOutcome`](../type-aliases/CheckOutcome.md) \| `Promise`\<[`CheckOutcome`](../type-aliases/CheckOutcome.md)\>
