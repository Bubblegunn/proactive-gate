[**proactive-gate**](../../README.md)

***

[proactive-gate](../../README.md) / [index](../README.md) / MemoryStore

# Class: MemoryStore

Defined in: [stores.ts:5](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/stores.ts#L5)

In-process store. Correct for one instance, wrong the moment you scale out.

## Implements

- [`Store`](../interfaces/Store.md)

## Constructors

### Constructor

> **new MemoryStore**(`clock?`): `MemoryStore`

Defined in: [stores.ts:8](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/stores.ts#L8)

#### Parameters

##### clock?

() => `number`

#### Returns

`MemoryStore`

## Methods

### del()

> **del**(`key`): `Promise`\<`void`\>

Defined in: [stores.ts:36](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/stores.ts#L36)

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

Defined in: [stores.ts:20](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/stores.ts#L20)

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

Defined in: [stores.ts:28](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/stores.ts#L28)

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

Defined in: [stores.ts:24](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/stores.ts#L24)

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

***

### size()

> **size**(): `number`

Defined in: [stores.ts:41](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/stores.ts#L41)

Test helper.

#### Returns

`number`
