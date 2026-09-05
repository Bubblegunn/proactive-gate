[**proactive-gate**](../../README.md)

***

[proactive-gate](../../README.md) / [index](../README.md) / Gate

# Interface: Gate

Defined in: [gate.ts:29](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/gate.ts#L29)

## Properties

### checks

> `readonly` **checks**: readonly [`Check`](Check.md)[]

Defined in: [gate.ts:43](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/gate.ts#L43)

## Methods

### commit()

> **commit**(`decision`, `input`): `Promise`\<`boolean`\>

Defined in: [gate.ts:38](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/gate.ts#L38)

Call right before you actually send. Consumes one unit of every budget-like
check, in order, and returns false if a unit was taken by a concurrent
delivery in the meantime. Idempotent on decision.id: a second call returns
the first result without consuming again.

#### Parameters

##### decision

[`Decision`](Decision.md)

##### input

[`EvaluateInput`](EvaluateInput.md)

#### Returns

`Promise`\<`boolean`\>

***

### evaluate()

> **evaluate**(`input`): `Promise`\<[`Decision`](Decision.md)\>

Defined in: [gate.ts:31](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/gate.ts#L31)

Run every check in order. Never throws for a check failure; see the trace.

#### Parameters

##### input

[`EvaluateInput`](EvaluateInput.md)

#### Returns

`Promise`\<[`Decision`](Decision.md)\>

***

### inspect()

> **inspect**(`user`, `now?`): `Promise`\<\{ `budgetUsed`: `number`; `dismissals`: `Record`\<`string`, `number`\>; \}\>

Defined in: [gate.ts:42](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/gate.ts#L42)

Snapshot of the current counters for a user, for debugging and UIs.

#### Parameters

##### user

[`UserState`](UserState.md)

##### now?

`Date`

#### Returns

`Promise`\<\{ `budgetUsed`: `number`; `dismissals`: `Record`\<`string`, `number`\>; \}\>

***

### record()

> **record**(`user`, `candidate`, `event`, `at?`): `Promise`\<`void`\>

Defined in: [gate.ts:40](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/gate.ts#L40)

Tell the gate what happened after delivery, so cooldowns can learn.

#### Parameters

##### user

`Pick`\<[`UserState`](UserState.md), `"id"`\>

##### candidate

`Pick`\<[`Candidate`](Candidate.md), `"type"`\>

##### event

[`OutcomeEvent`](../type-aliases/OutcomeEvent.md)

##### at?

`Date`

#### Returns

`Promise`\<`void`\>
