[**proactive-gate**](../../../../README.md)

***

[proactive-gate](../../../../README.md) / [index](../../../README.md) / [checks](../README.md) / rateLimit

# Function: rateLimit()

> **rateLimit**(`options`): [`BudgetCheck`](../interfaces/BudgetCheck.md)

Defined in: [checks.ts:378](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/checks.ts#L378)

Fixed-window rate limit keyed by user or by candidate.channel; consumed at commit.

## Parameters

### options

#### id?

`string`

#### keyBy?

`"user"` \| `"channel"`

#### limit

`number`

#### perSeconds

`number`

## Returns

[`BudgetCheck`](../interfaces/BudgetCheck.md)
