[**proactive-gate**](../../../../README.md)

***

[proactive-gate](../../../../README.md) / [index](../../../README.md) / [checks](../README.md) / adaptiveTiming

# Function: adaptiveTiming()

> **adaptiveTiming**(`options?`): [`Check`](../../../interfaces/Check.md)

Defined in: [checks.ts:198](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/checks.ts#L198)

Never rejects. Moves a delivery to the user's next good moment when the
caller supplies one, and can narrow surfaces. The default keeps the
candidate where it is; pass `nextGoodMoment` to plug in your own model.

## Parameters

### options?

#### nextGoodMoment?

(`ctx`) => `Date` \| `Promise`\<`Date` \| `null`\> \| `null`

#### surfacesFor?

(`ctx`) => [`Surface`](../../../type-aliases/Surface.md)[] \| `null`

## Returns

[`Check`](../../../interfaces/Check.md)
