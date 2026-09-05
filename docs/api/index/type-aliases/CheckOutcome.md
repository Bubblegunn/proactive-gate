[**proactive-gate**](../../README.md)

***

[proactive-gate](../../README.md) / [index](../README.md) / CheckOutcome

# Type Alias: CheckOutcome

> **CheckOutcome** = \{ `kind`: `"pass"`; `nearLimit?`: \{ `limit`: `number`; `used`: `number`; \}; `reason?`: `string`; \} \| \{ `kind`: `"reject"`; `reason`: `string`; \} \| \{ `deliverAt?`: `Date`; `kind`: `"adjust"`; `reason`: `string`; `surfaces?`: [`Surface`](Surface.md)[]; \} \| \{ `kind`: `"skip"`; `reason`: `string`; \} \| \{ `kind`: `"defer"`; `reason`: `string`; `retryAt`: `Date`; \}

Defined in: [types.ts:70](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L70)

What a single check may say.
