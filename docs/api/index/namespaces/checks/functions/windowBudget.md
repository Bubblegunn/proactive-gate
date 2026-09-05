[**proactive-gate**](../../../../README.md)

***

[proactive-gate](../../../../README.md) / [index](../../../README.md) / [checks](../README.md) / windowBudget

# Function: windowBudget()

> **windowBudget**(`options`): [`BudgetCheck`](../interfaces/BudgetCheck.md)

Defined in: [checks.ts:402](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/checks.ts#L402)

At most `limit` deliveries in the `withinHours` window that opened with the user's last inbound message.

## Parameters

### options

#### limit

`number`

#### withinHours

`number`

## Returns

[`BudgetCheck`](../interfaces/BudgetCheck.md)
