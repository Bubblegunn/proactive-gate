[**proactive-gate**](../../README.md)

***

[proactive-gate](../../README.md) / [index](../README.md) / SqliteStore

# Class: SqliteStore

Defined in: [stores.ts:86](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/stores.ts#L86)

Minimal key-value contract. MemoryStore ships with the package; wrap a Redis
client with RedisStore. Every method may throw; the gate decides per check
whether a store failure fails open or closed.

## Implements

- [`Store`](../interfaces/Store.md)

## Constructors

### Constructor

> **new SqliteStore**(`path`, `clock?`): `SqliteStore`

Defined in: [stores.ts:90](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/stores.ts#L90)

#### Parameters

##### path

`string`

##### clock?

() => `number`

#### Returns

`SqliteStore`

## Methods

### close()

> **close**(): `void`

Defined in: [stores.ts:143](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/stores.ts#L143)

#### Returns

`void`

***

### del()

> **del**(`key`): `Promise`\<`void`\>

Defined in: [stores.ts:139](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/stores.ts#L139)

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

Defined in: [stores.ts:115](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/stores.ts#L115)

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

Defined in: [stores.ts:128](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/stores.ts#L128)

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

Defined in: [stores.ts:119](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/stores.ts#L119)

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
