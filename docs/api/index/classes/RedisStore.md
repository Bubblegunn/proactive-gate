[**proactive-gate**](../../README.md)

***

[proactive-gate](../../README.md) / [index](../README.md) / RedisStore

# Class: RedisStore

Defined in: [stores.ts:63](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/stores.ts#L63)

Redis-backed store. `incr` is atomic on the server, which is what makes the
daily budget safe across many instances; the TTL is attached on the first
increment so a day's counter disappears on its own.

## Implements

- [`Store`](../interfaces/Store.md)

## Constructors

### Constructor

> **new RedisStore**(`client`): `RedisStore`

Defined in: [stores.ts:64](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/stores.ts#L64)

#### Parameters

##### client

[`RedisLike`](../interfaces/RedisLike.md)

#### Returns

`RedisStore`

## Methods

### del()

> **del**(`key`): `Promise`\<`void`\>

Defined in: [stores.ts:81](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/stores.ts#L81)

#### Parameters

##### key

`string`

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`Store`](../interfaces/Store.md).[`del`](../interfaces/Store.md#del)

***

### get()

> **get**(`key`): `Promise`\<`string` \| `null`\>

Defined in: [stores.ts:66](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/stores.ts#L66)

#### Parameters

##### key

`string`

#### Returns

`Promise`\<`string` \| `null`\>

#### Implementation of

[`Store`](../interfaces/Store.md).[`get`](../interfaces/Store.md#get)

***

### incr()

> **incr**(`key`, `ttlSeconds?`): `Promise`\<`number`\>

Defined in: [stores.ts:75](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/stores.ts#L75)

Atomic increment. Returns the new value.

#### Parameters

##### key

`string`

##### ttlSeconds?

`number`

#### Returns

`Promise`\<`number`\>

#### Implementation of

[`Store`](../interfaces/Store.md).[`incr`](../interfaces/Store.md#incr)

***

### set()

> **set**(`key`, `value`, `ttlSeconds?`): `Promise`\<`void`\>

Defined in: [stores.ts:70](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/stores.ts#L70)

#### Parameters

##### key

`string`

##### value

`string`

##### ttlSeconds?

`number`

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`Store`](../interfaces/Store.md).[`set`](../interfaces/Store.md#set)
