[**proactive-gate**](../../../../README.md)

***

[proactive-gate](../../../../README.md) / [checks](../README.md) / adaptiveTiming

# Function: adaptiveTiming()

> **adaptiveTiming**(`options?`): [`Check`](../../../../interfaces/Check.md)

Defined in: [checks.ts:193](https://github.com/Bubblegunn/proactive-gate/blob/15a395704bd6e966431832fa7873e9eb88b1be58/src/checks.ts#L193)

Never rejects. Moves a delivery to the user's next good moment when the
caller supplies one, and can narrow surfaces. The default keeps the
candidate where it is; pass `nextGoodMoment` to plug in your own model.

## Parameters

### options?

#### nextGoodMoment?

(`ctx`) => `Date` \| `Promise`\<`Date` \| `null`\> \| `null`

#### surfacesFor?

(`ctx`) => [`Surface`](../../../../type-aliases/Surface.md)[] \| `null`

## Returns

[`Check`](../../../../interfaces/Check.md)
