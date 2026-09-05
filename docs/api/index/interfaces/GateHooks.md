[**proactive-gate**](../../README.md)

***

[proactive-gate](../../README.md) / [index](../README.md) / GateHooks

# Interface: GateHooks

Defined in: [types.ts:155](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L155)

Observation points. Hooks never change a decision; a throwing hook is reported to `error` and ignored.

## Methods

### after()?

> `optional` **after**(`ctx`, `check`, `outcome`, `ms`): `void` \| `Promise`\<`void`\>

Defined in: [types.ts:157](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L157)

#### Parameters

##### ctx

[`CheckContext`](CheckContext.md)

##### check

[`Check`](Check.md)

##### outcome

[`CheckOutcome`](../type-aliases/CheckOutcome.md)

##### ms

`number`

#### Returns

`void` \| `Promise`\<`void`\>

***

### before()?

> `optional` **before**(`ctx`, `check`): `void` \| `Promise`\<`void`\>

Defined in: [types.ts:156](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L156)

#### Parameters

##### ctx

[`CheckContext`](CheckContext.md)

##### check

[`Check`](Check.md)

#### Returns

`void` \| `Promise`\<`void`\>

***

### error()?

> `optional` **error**(`ctx`, `check`, `error`): `void` \| `Promise`\<`void`\>

Defined in: [types.ts:158](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L158)

#### Parameters

##### ctx

[`CheckContext`](CheckContext.md)

##### check

[`Check`](Check.md)

##### error

`unknown`

#### Returns

`void` \| `Promise`\<`void`\>

***

### finally()?

> `optional` **finally**(`decision`): `void` \| `Promise`\<`void`\>

Defined in: [types.ts:159](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L159)

#### Parameters

##### decision

[`Decision`](Decision.md)

#### Returns

`void` \| `Promise`\<`void`\>
