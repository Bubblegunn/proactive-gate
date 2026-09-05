[**proactive-gate**](../../../../README.md)

***

[proactive-gate](../../../../README.md) / [index](../../../README.md) / [checks](../README.md) / killSwitch

# Function: killSwitch()

> **killSwitch**(`isOn`): [`Check`](../../../interfaces/Check.md)

Defined in: [checks.ts:54](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/checks.ts#L54)

A production hard-stop that silences every producer at once.

## Parameters

### isOn

() => `boolean` \| `Promise`\<`boolean`\>

## Returns

[`Check`](../../../interfaces/Check.md)
