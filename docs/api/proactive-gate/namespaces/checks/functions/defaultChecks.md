[**proactive-gate**](../../../../README.md)

***

[proactive-gate](../../../../README.md) / [checks](../README.md) / defaultChecks

# Function: defaultChecks()

> **defaultChecks**(`options?`): [`Check`](../../../../interfaces/Check.md)[]

Defined in: [checks.ts:239](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/checks.ts#L239)

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

[`Priority`](../../../../type-aliases/Priority.md)

## Returns

[`Check`](../../../../interfaces/Check.md)[]
