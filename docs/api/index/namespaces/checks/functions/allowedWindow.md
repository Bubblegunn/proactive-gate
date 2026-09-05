[**proactive-gate**](../../../../README.md)

***

[proactive-gate](../../../../README.md) / [index](../../../README.md) / [checks](../README.md) / allowedWindow

# Function: allowedWindow()

> **allowedWindow**(`options`): [`Check`](../../../interfaces/Check.md)

Defined in: [checks.ts:346](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/checks.ts#L346)

Deliveries only inside [start, end) local time in a fixed zone or the user's.

## Parameters

### options

#### end

`string`

#### id?

`string`

#### priorityFloor?

[`Priority`](../../../type-aliases/Priority.md)

#### start

`string`

#### timezone

`string`

## Returns

[`Check`](../../../interfaces/Check.md)
