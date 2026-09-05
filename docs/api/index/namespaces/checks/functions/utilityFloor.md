[**proactive-gate**](../../../../README.md)

***

[proactive-gate](../../../../README.md) / [index](../../../README.md) / [checks](../README.md) / utilityFloor

# Function: utilityFloor()

> **utilityFloor**(`options`): [`Check`](../../../interfaces/Check.md)

Defined in: [checks.ts:294](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/checks.ts#L294)

Horvitz's expected-utility rule with the PRISM threshold: act only when the
caller's estimate of acceptance clears tau = cFA / (cFA + pNeed * cFN).
`candidate.pAccept` and `candidate.pNeed` come from the caller's own model.

## Parameters

### options

#### costFalseAlarm

`number`

#### costMissedHelp

`number`

## Returns

[`Check`](../../../interfaces/Check.md)
