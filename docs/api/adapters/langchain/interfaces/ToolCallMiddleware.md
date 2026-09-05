[**proactive-gate**](../../../README.md)

***

[proactive-gate](../../../README.md) / [adapters/langchain](../README.md) / ToolCallMiddleware

# Interface: ToolCallMiddleware\<R, T\>

Defined in: [adapters/langchain.ts:23](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/adapters/langchain.ts#L23)

## Type Parameters

### R

`R` *extends* [`ToolCallRequest`](ToolCallRequest.md) = [`ToolCallRequest`](ToolCallRequest.md)

### T

`T` = `unknown`

## Properties

### name

> **name**: `string`

Defined in: [adapters/langchain.ts:24](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/adapters/langchain.ts#L24)

## Methods

### wrapToolCall()

> **wrapToolCall**(`request`, `handler`): `Promise`\<[`ToolMessageLike`](ToolMessageLike.md) \| `T`\>

Defined in: [adapters/langchain.ts:25](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/adapters/langchain.ts#L25)

#### Parameters

##### request

`R`

##### handler

(`request`) => `Promise`\<`T`\>

#### Returns

`Promise`\<[`ToolMessageLike`](ToolMessageLike.md) \| `T`\>
