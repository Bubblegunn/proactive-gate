[**proactive-gate**](../../../../README.md)

***

[proactive-gate](../../../../README.md) / [index](../../../README.md) / [checks](../README.md) / requiresConsent

# Function: requiresConsent()

> **requiresConsent**(`options`): [`Check`](../../../interfaces/Check.md)

Defined in: [checks.ts:362](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/checks.ts#L362)

Requires `user.consents[name]`, always or only inside a local-time window.

## Parameters

### options

#### id?

`string`

#### name

`string`

#### when?

\{ `end`: `string`; `start`: `string`; `timezone`: `string`; \}

#### when.end

`string`

#### when.start

`string`

#### when.timezone

`string`

## Returns

[`Check`](../../../interfaces/Check.md)
