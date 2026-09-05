[**proactive-gate**](../README.md)

***

[proactive-gate](../README.md) / MemoryStore

# Class: MemoryStore

Defined in: [stores.ts:4](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/stores.ts#L4)

In-process store. Correct for one instance, wrong the moment you scale out.

## Implements

- [`Store`](../interfaces/Store.md)

## Constructors

### Constructor

> **new MemoryStore**(`clock?`): `MemoryStore`

Defined in: [stores.ts:7](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/stores.ts#L7)

#### Parameters

##### clock?

() => `number`

#### Returns

`MemoryStore`

## Methods

### del()

> **del**(`key`): `Promise`\<`void`\>

Defined in: [stores.ts:35](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/stores.ts#L35)

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

Defined in: [stores.ts:19](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/stores.ts#L19)

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

Defined in: [stores.ts:27](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/stores.ts#L27)

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

Defined in: [stores.ts:23](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/stores.ts#L23)

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

Defined in: [stores.ts:40](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/stores.ts#L40)

Test helper.

#### Returns

`number`
