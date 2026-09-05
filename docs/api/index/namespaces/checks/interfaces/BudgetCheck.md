[**proactive-gate**](../../../../README.md)

***

[proactive-gate](../../../../README.md) / [index](../../../README.md) / [checks](../README.md) / BudgetCheck

# Interface: BudgetCheck

Defined in: [checks.ts:222](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/checks.ts#L222)

## Extends

- [`Check`](../../../interfaces/Check.md)

## Properties

### id

> **id**: `string`

Defined in: [types.ts:88](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L88)

#### Inherited from

[`Check`](../../../interfaces/Check.md).[`id`](../../../interfaces/Check.md#id)

***

### limit

> **limit**: `number`

Defined in: [checks.ts:223](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/checks.ts#L223)

***

### nonRejecting?

> `optional` **nonRejecting?**: `boolean`

Defined in: [types.ts:90](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L90)

True when the check can never reject; it only adjusts timing or surfaces.

#### Inherited from

[`Check`](../../../interfaces/Check.md).[`nonRejecting`](../../../interfaces/Check.md#nonrejecting)

***

### shadow?

> `optional` **shadow?**: `boolean`

Defined in: [types.ts:92](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L92)

True to record what the check would have done without letting it stop evaluation.

#### Inherited from

[`Check`](../../../interfaces/Check.md).[`shadow`](../../../interfaces/Check.md#shadow)

## Methods

### consume()

> **consume**(`ctx`): `Promise`\<`boolean`\>

Defined in: [checks.ts:224](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/checks.ts#L224)

Budget-like checks consume one unit at commit time. Return false when the
unit was not available (a concurrent delivery took it). The gate calls
consume() in check order, once per decision.

#### Parameters

##### ctx

[`CheckContext`](../../../interfaces/CheckContext.md)

#### Returns

`Promise`\<`boolean`\>

#### Overrides

[`Check`](../../../interfaces/Check.md).[`consume`](../../../interfaces/Check.md#consume)

***

### run()

> **run**(`ctx`): [`CheckOutcome`](../../../type-aliases/CheckOutcome.md) \| `Promise`\<[`CheckOutcome`](../../../type-aliases/CheckOutcome.md)\>

Defined in: [types.ts:93](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L93)

#### Parameters

##### ctx

[`CheckContext`](../../../interfaces/CheckContext.md)

#### Returns

[`CheckOutcome`](../../../type-aliases/CheckOutcome.md) \| `Promise`\<[`CheckOutcome`](../../../type-aliases/CheckOutcome.md)\>

#### Inherited from

[`Check`](../../../interfaces/Check.md).[`run`](../../../interfaces/Check.md#run)
