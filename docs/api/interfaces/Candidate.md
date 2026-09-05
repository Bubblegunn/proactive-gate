[**proactive-gate**](../README.md)

***

[proactive-gate](../README.md) / Candidate

# Interface: Candidate

Defined in: [types.ts:35](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L35)

The thing the agent wants to say.

## Properties

### id

> **id**: `string`

Defined in: [types.ts:36](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L36)

***

### payload?

> `optional` **payload?**: `unknown`

Defined in: [types.ts:43](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L43)

Free-form payload; the gate never reads it.

***

### priority?

> `optional` **priority?**: [`Priority`](../type-aliases/Priority.md)

Defined in: [types.ts:39](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L39)

***

### surfaces?

> `optional` **surfaces?**: [`Surface`](../type-aliases/Surface.md)[]

Defined in: [types.ts:41](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L41)

Surfaces this candidate can be delivered on, in preference order.

***

### type

> **type**: `string`

Defined in: [types.ts:38](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L38)

A stable category such as "reminder", "insight", "follow_up". Used by mute and cooldown.
