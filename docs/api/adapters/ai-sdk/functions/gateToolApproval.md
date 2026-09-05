[**proactive-gate**](../../../README.md)

***

[proactive-gate](../../../README.md) / [adapters/ai-sdk](../README.md) / gateToolApproval

# Function: gateToolApproval()

> **gateToolApproval**\<`T`\>(`options`): (`call`) => `Promise`\<[`ToolApprovalResult`](../interfaces/ToolApprovalResult.md)\>

Defined in: [adapters/ai-sdk.ts:27](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/adapters/ai-sdk.ts#L27)

## Type Parameters

### T

`T` *extends* [`ToolApprovalRequest`](../interfaces/ToolApprovalRequest.md)

## Parameters

### options

#### commit?

`boolean`

Also consume the budget on approval. Default true.

#### gate

[`Gate`](../../../index/interfaces/Gate.md)

#### toInput

(`call`) => [`EvaluateInput`](../../../index/interfaces/EvaluateInput.md)

## Returns

(`call`) => `Promise`\<[`ToolApprovalResult`](../interfaces/ToolApprovalResult.md)\>
