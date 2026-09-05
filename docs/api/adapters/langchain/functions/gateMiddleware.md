[**proactive-gate**](../../../README.md)

***

[proactive-gate](../../../README.md) / [adapters/langchain](../README.md) / gateMiddleware

# Function: gateMiddleware()

> **gateMiddleware**\<`R`, `T`\>(`options`): [`ToolCallMiddleware`](../interfaces/ToolCallMiddleware.md)\<`R`, `T`\>

Defined in: [adapters/langchain.ts:28](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/adapters/langchain.ts#L28)

## Type Parameters

### R

`R` *extends* [`ToolCallRequest`](../interfaces/ToolCallRequest.md) = [`ToolCallRequest`](../interfaces/ToolCallRequest.md)

### T

`T` = `unknown`

## Parameters

### options

#### commit?

`boolean`

#### gate

[`Gate`](../../../index/interfaces/Gate.md)

#### toInput

(`request`) => [`EvaluateInput`](../../../index/interfaces/EvaluateInput.md)

#### tools

`string`[]

## Returns

[`ToolCallMiddleware`](../interfaces/ToolCallMiddleware.md)\<`R`, `T`\>
