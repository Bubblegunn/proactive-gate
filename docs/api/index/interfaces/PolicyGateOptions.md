[**proactive-gate**](../../README.md)

***

[proactive-gate](../../README.md) / [index](../README.md) / PolicyGateOptions

# Interface: PolicyGateOptions

Defined in: [gate.ts:47](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/gate.ts#L47)

createGate accepts explicit checks or a JSON policy (see spec/schema/policy.schema.json).

## Properties

### hooks?

> `optional` **hooks?**: [`GateHooks`](GateHooks.md)

Defined in: [gate.ts:51](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/gate.ts#L51)

***

### onDecision?

> `optional` **onDecision?**: (`decision`) => `void`

Defined in: [gate.ts:50](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/gate.ts#L50)

#### Parameters

##### decision

[`Decision`](Decision.md)

#### Returns

`void`

***

### policy

> **policy**: [`Policy`](Policy.md)

Defined in: [gate.ts:48](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/gate.ts#L48)

***

### store?

> `optional` **store?**: [`Store`](Store.md)

Defined in: [gate.ts:49](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/gate.ts#L49)
