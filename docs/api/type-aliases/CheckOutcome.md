[**proactive-gate**](../README.md)

***

[proactive-gate](../README.md) / CheckOutcome

# Type Alias: CheckOutcome

> **CheckOutcome** = \{ `kind`: `"pass"`; \} \| \{ `kind`: `"reject"`; `reason`: `string`; \} \| \{ `deliverAt?`: `Date`; `kind`: `"adjust"`; `reason`: `string`; `surfaces?`: [`Surface`](Surface.md)[]; \} \| \{ `kind`: `"skip"`; `reason`: `string`; \}

Defined in: [types.ts:54](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/types.ts#L54)

What a single check may say.
