[**proactive-gate**](../../README.md)

***

[proactive-gate](../../README.md) / [index](../README.md) / TraceEntry

# Interface: TraceEntry

Defined in: [types.ts:102](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L102)

## Properties

### id

> **id**: `string`

Defined in: [types.ts:103](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L103)

***

### ms

> **ms**: `number`

Defined in: [types.ts:106](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L106)

***

### outcome

> **outcome**: `"pass"` \| `"reject"` \| `"adjust"` \| `"skip"` \| `"defer"`

Defined in: [types.ts:104](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L104)

***

### reason?

> `optional` **reason?**: `string`

Defined in: [types.ts:105](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L105)

***

### shadow?

> `optional` **shadow?**: `boolean`

Defined in: [types.ts:108](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L108)

Present when the check ran in shadow mode and would have stopped evaluation.
