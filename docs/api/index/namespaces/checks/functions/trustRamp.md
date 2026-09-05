[**proactive-gate**](../../../../README.md)

***

[proactive-gate](../../../../README.md) / [index](../../../README.md) / [checks](../README.md) / trustRamp

# Function: trustRamp()

> **trustRamp**(`options?`): [`Check`](../../../interfaces/Check.md)

Defined in: [checks.ts:149](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/checks.ts#L149)

For the first `days` after sign-up the user hears from the system only at
or above `minPriority`. A proactive assistant is least calibrated exactly
when the user is least forgiving.

## Parameters

### options?

#### days?

`number`

#### minPriority?

[`Priority`](../../../type-aliases/Priority.md)

## Returns

[`Check`](../../../interfaces/Check.md)
