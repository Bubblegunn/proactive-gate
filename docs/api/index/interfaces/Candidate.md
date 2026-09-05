[**proactive-gate**](../../README.md)

***

[proactive-gate](../../README.md) / [index](../README.md) / Candidate

# Interface: Candidate

Defined in: [types.ts:43](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L43)

The thing the agent wants to say.

## Properties

### busy?

> `optional` **busy?**: `boolean`

Defined in: [types.ts:53](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L53)

The caller's own signal that the user is busy right now; boundedDeferral reads it.

***

### channel?

> `optional` **channel?**: `string`

Defined in: [types.ts:51](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L51)

Channel or chat the message goes to; rate limits keyed by channel read it.

***

### id

> **id**: `string`

Defined in: [types.ts:44](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L44)

***

### pAccept?

> `optional` **pAccept?**: `number`

Defined in: [types.ts:55](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L55)

Caller-estimated probability the user accepts this message; utilityFloor reads it.

***

### payload?

> `optional` **payload?**: `unknown`

Defined in: [types.ts:59](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L59)

Free-form payload; the gate never reads it.

***

### pNeed?

> `optional` **pNeed?**: `number`

Defined in: [types.ts:57](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L57)

Caller-estimated probability the user needs it; utilityFloor reads it, default 1.

***

### priority?

> `optional` **priority?**: [`Priority`](../type-aliases/Priority.md)

Defined in: [types.ts:47](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L47)

***

### surfaces?

> `optional` **surfaces?**: [`Surface`](../type-aliases/Surface.md)[]

Defined in: [types.ts:49](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L49)

Surfaces this candidate can be delivered on, in preference order.

***

### type

> **type**: `string`

Defined in: [types.ts:46](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L46)

A stable category such as "reminder", "insight", "follow_up". Used by mute and cooldown.
