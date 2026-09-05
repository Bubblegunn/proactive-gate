[**proactive-gate**](../README.md)

***

[proactive-gate](../README.md) / RedisLike

# Interface: RedisLike

Defined in: [stores.ts:49](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/stores.ts#L49)

The subset of a Redis client the gate needs. Both ioredis and node-redis
satisfy it (node-redis names are upper-case; pass a small adapter).

## Methods

### del()

> **del**(`key`): `Promise`\<`unknown`\>

Defined in: [stores.ts:54](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/stores.ts#L54)

#### Parameters

##### key

`string`

#### Returns

`Promise`\<`unknown`\>

***

### expire()

> **expire**(`key`, `seconds`): `Promise`\<`unknown`\>

Defined in: [stores.ts:53](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/stores.ts#L53)

#### Parameters

##### key

`string`

##### seconds

`number`

#### Returns

`Promise`\<`unknown`\>

***

### get()

> **get**(`key`): `Promise`\<`string` \| `null`\>

Defined in: [stores.ts:50](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/stores.ts#L50)

#### Parameters

##### key

`string`

#### Returns

`Promise`\<`string` \| `null`\>

***

### incr()

> **incr**(`key`): `Promise`\<`number`\>

Defined in: [stores.ts:52](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/stores.ts#L52)

#### Parameters

##### key

`string`

#### Returns

`Promise`\<`number`\>

***

### set()

> **set**(`key`, `value`, ...`args`): `Promise`\<`unknown`\>

Defined in: [stores.ts:51](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/stores.ts#L51)

#### Parameters

##### key

`string`

##### value

`string`

##### args

...`any`[]

#### Returns

`Promise`\<`unknown`\>
