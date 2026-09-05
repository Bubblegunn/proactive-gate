[**proactive-gate**](../../../../README.md)

***

[proactive-gate](../../../../README.md) / [checks](../README.md) / killSwitch

# Function: killSwitch()

> **killSwitch**(`isOn`): [`Check`](../../../../interfaces/Check.md)

Defined in: [checks.ts:51](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/checks.ts#L51)

A production hard-stop that silences every producer at once.

## Parameters

### isOn

() => `boolean` \| `Promise`\<`boolean`\>

## Returns

[`Check`](../../../../interfaces/Check.md)
