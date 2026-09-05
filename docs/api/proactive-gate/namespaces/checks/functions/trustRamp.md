[**proactive-gate**](../../../../README.md)

***

[proactive-gate](../../../../README.md) / [checks](../README.md) / trustRamp

# Function: trustRamp()

> **trustRamp**(`options?`): [`Check`](../../../../interfaces/Check.md)

Defined in: [checks.ts:144](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/checks.ts#L144)

For the first `days` after sign-up the user hears from the system only at
or above `minPriority`. A proactive assistant is least calibrated exactly
when the user is least forgiving.

## Parameters

### options?

#### days?

`number`

#### minPriority?

[`Priority`](../../../../type-aliases/Priority.md)

## Returns

[`Check`](../../../../interfaces/Check.md)
