[**proactive-gate**](../../README.md)

***

[proactive-gate](../../README.md) / [index](../README.md) / Store

# Interface: Store

Defined in: [types.ts:146](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L146)

Minimal key-value contract. MemoryStore ships with the package; wrap a Redis
client with RedisStore. Every method may throw; the gate decides per check
whether a store failure fails open or closed.

## Methods

### del()

> **del**(`key`): `Promise`\<`void`\>

Defined in: [types.ts:151](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L151)

#### Parameters

##### key

`string`

#### Returns

`Promise`\<`void`\>

***

### get()

> **get**(`key`): `Promise`\<`string` \| `null`\>

Defined in: [types.ts:147](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L147)

#### Parameters

##### key

`string`

#### Returns

`Promise`\<`string` \| `null`\>

***

### incr()

> **incr**(`key`, `ttlSeconds?`): `Promise`\<`number`\>

Defined in: [types.ts:150](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L150)

Atomic increment. Returns the new value.

#### Parameters

##### key

`string`

##### ttlSeconds?

`number`

#### Returns

`Promise`\<`number`\>

***

### set()

> **set**(`key`, `value`, `ttlSeconds?`): `Promise`\<`void`\>

Defined in: [types.ts:148](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L148)

#### Parameters

##### key

`string`

##### value

`string`

##### ttlSeconds?

`number`

#### Returns

`Promise`\<`void`\>
