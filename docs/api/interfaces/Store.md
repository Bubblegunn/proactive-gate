[**proactive-gate**](../README.md)

***

[proactive-gate](../README.md) / Store

# Interface: Store

Defined in: [types.ts:109](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L109)

Minimal key-value contract. MemoryStore ships with the package; wrap a Redis
client with RedisStore. Every method may throw; the gate decides per check
whether a store failure fails open or closed.

## Methods

### del()

> **del**(`key`): `Promise`\<`void`\>

Defined in: [types.ts:114](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L114)

#### Parameters

##### key

`string`

#### Returns

`Promise`\<`void`\>

***

### get()

> **get**(`key`): `Promise`\<`string` \| `null`\>

Defined in: [types.ts:110](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L110)

#### Parameters

##### key

`string`

#### Returns

`Promise`\<`string` \| `null`\>

***

### incr()

> **incr**(`key`, `ttlSeconds?`): `Promise`\<`number`\>

Defined in: [types.ts:113](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L113)

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

Defined in: [types.ts:111](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L111)

#### Parameters

##### key

`string`

##### value

`string`

##### ttlSeconds?

`number`

#### Returns

`Promise`\<`void`\>
