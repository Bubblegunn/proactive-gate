[**proactive-gate**](../../../../README.md)

***

[proactive-gate](../../../../README.md) / [index](../../../README.md) / [checks](../README.md) / intensity

# Function: intensity()

> **intensity**(`floors?`): [`Check`](../../../interfaces/Check.md)

Defined in: [checks.ts:116](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/checks.ts#L116)

The user's intensity setting maps to a priority floor:
low hears only high priority, normal hears normal and up, high hears everything.

## Parameters

### floors?

`Record`\<`"low"` \| `"normal"` \| `"high"`, [`Priority`](../../../type-aliases/Priority.md)\> = `...`

## Returns

[`Check`](../../../interfaces/Check.md)
