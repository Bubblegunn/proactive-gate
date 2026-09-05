[**proactive-gate**](../../README.md)

***

[proactive-gate](../../README.md) / [index](../README.md) / UserState

# Interface: UserState

Defined in: [types.ts:10](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L10)

Everything the gate knows about the person it might interrupt.

## Properties

### consent

> **consent**: `boolean`

Defined in: [types.ts:13](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L13)

Has the user agreed to proactive behaviour at all?

***

### consents?

> `optional` **consents?**: `Record`\<`string`, `boolean`\>

Defined in: [types.ts:33](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L33)

Named consents a preset can require, e.g. { ad: true, night: false }.

***

### createdAt?

> `optional` **createdAt?**: `string` \| `Date`

Defined in: [types.ts:29](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L29)

When the user joined. Drives the trust ramp.

***

### existingCustomer?

> `optional` **existingCustomer?**: `boolean`

Defined in: [types.ts:39](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L39)

True when a soft opt-in for existing customers applies.

***

### id

> **id**: `string`

Defined in: [types.ts:11](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L11)

***

### intensity?

> `optional` **intensity?**: `"low"` \| `"normal"` \| `"high"`

Defined in: [types.ts:23](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L23)

How much the user wants to hear from the assistant.

***

### lastInboundAt?

> `optional` **lastInboundAt?**: `string` \| `Date` \| `null`

Defined in: [types.ts:35](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L35)

Last message the user sent to the assistant; drives inbound-window presets.

***

### minor?

> `optional` **minor?**: `boolean`

Defined in: [types.ts:37](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L37)

True when the user is a minor under the applicable rules.

***

### mode?

> `optional` **mode?**: `string`

Defined in: [types.ts:17](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L17)

Operating mode of the assistant for this user, e.g. "normal", "focus", "vacation".

***

### mutedTypes?

> `optional` **mutedTypes?**: `string`[]

Defined in: [types.ts:21](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L21)

Candidate types the user has muted.

***

### proactiveEnabled?

> `optional` **proactiveEnabled?**: `boolean`

Defined in: [types.ts:15](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L15)

Is proactive behaviour switched on for this profile right now?

***

### quietHours?

> `optional` **quietHours?**: \{ `end`: `string`; `start`: `string`; \} \| `null`

Defined in: [types.ts:27](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L27)

Quiet hours in local time, "HH:MM". May cross midnight.

***

### snoozedUntil?

> `optional` **snoozedUntil?**: `string` \| `Date` \| `null`

Defined in: [types.ts:19](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L19)

Global pause until this instant.

***

### surfaces?

> `optional` **surfaces?**: [`Surface`](../type-aliases/Surface.md)[]

Defined in: [types.ts:31](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L31)

Surfaces the user allows, in preference order. Defaults to the candidate's surfaces.

***

### timezone?

> `optional` **timezone?**: `string`

Defined in: [types.ts:25](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/types.ts#L25)

IANA time zone, required for quiet hours.
