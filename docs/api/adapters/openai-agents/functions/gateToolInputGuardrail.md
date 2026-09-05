[**proactive-gate**](../../../README.md)

***

[proactive-gate](../../../README.md) / [adapters/openai-agents](../README.md) / gateToolInputGuardrail

# Function: gateToolInputGuardrail()

> **gateToolInputGuardrail**\<`I`\>(`options`): [`ToolInputGuardrail`](../interfaces/ToolInputGuardrail.md)\<`I`\>

Defined in: [adapters/openai-agents.ts:27](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/adapters/openai-agents.ts#L27)

## Type Parameters

### I

`I` = `unknown`

## Parameters

### options

#### commit?

`boolean`

#### gate

[`Gate`](../../../index/interfaces/Gate.md)

#### name?

`string`

#### toInput

(`args`) => [`EvaluateInput`](../../../index/interfaces/EvaluateInput.md)

## Returns

[`ToolInputGuardrail`](../interfaces/ToolInputGuardrail.md)\<`I`\>
