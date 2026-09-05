[**proactive-gate**](../README.md)

***

[proactive-gate](../README.md) / Gate

# Interface: Gate

Defined in: [gate.ts:25](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/gate.ts#L25)

## Properties

### checks

> `readonly` **checks**: readonly [`Check`](Check.md)[]

Defined in: [gate.ts:38](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/gate.ts#L38)

## Methods

### commit()

> **commit**(`decision`, `input`): `Promise`\<`boolean`\>

Defined in: [gate.ts:33](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/gate.ts#L33)

Call right before you actually send. Atomically consumes one unit of the
user's daily budget when a dailyBudget check is configured, and returns
false if the budget was exhausted by a concurrent delivery in the meantime.

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

Defined in: [gate.ts:27](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/gate.ts#L27)

Run every check in order. Never throws for a check failure; see the trace.

#### Parameters

##### input

[`EvaluateInput`](EvaluateInput.md)

#### Returns

`Promise`\<[`Decision`](Decision.md)\>

***

### inspect()

> **inspect**(`user`, `now?`): `Promise`\<\{ `budgetUsed`: `number`; `dismissals`: `Record`\<`string`, `number`\>; \}\>

Defined in: [gate.ts:37](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/gate.ts#L37)

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

Defined in: [gate.ts:35](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/gate.ts#L35)

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
