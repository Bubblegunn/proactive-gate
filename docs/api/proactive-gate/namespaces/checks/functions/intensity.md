[**proactive-gate**](../../../../README.md)

***

[proactive-gate](../../../../README.md) / [checks](../README.md) / intensity

# Function: intensity()

> **intensity**(`floors?`): [`Check`](../../../../interfaces/Check.md)

Defined in: [checks.ts:111](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/checks.ts#L111)

The user's intensity setting maps to a priority floor:
low hears only high priority, normal hears normal and up, high hears everything.

## Parameters

### floors?

`Record`\<`"low"` \| `"normal"` \| `"high"`, [`Priority`](../../../../type-aliases/Priority.md)\> = `...`

## Returns

[`Check`](../../../../interfaces/Check.md)
