[**proactive-gate**](../../../../README.md)

***

[proactive-gate](../../../../README.md) / [index](../../../README.md) / [checks](../README.md) / defaultChecks

# Function: defaultChecks()

> **defaultChecks**(`options?`): [`Check`](../../../interfaces/Check.md)[]

Defined in: [checks.ts:411](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/checks.ts#L411)

The LILA order, as a starting point. Replace, reorder, or drop checks freely.

## Parameters

### options?

#### dailyLimit?

`number`

#### killSwitch?

() => `boolean` \| `Promise`\<`boolean`\>

#### modes?

`string`[]

#### quietHoursFloor?

[`Priority`](../../../type-aliases/Priority.md)

#### weeklyLimit?

`number`

## Returns

[`Check`](../../../interfaces/Check.md)[]
