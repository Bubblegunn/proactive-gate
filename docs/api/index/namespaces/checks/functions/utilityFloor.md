[**proactive-gate**](../../../../README.md)

***

[proactive-gate](../../../../README.md) / [index](../../../README.md) / [checks](../README.md) / utilityFloor

# Function: utilityFloor()

> **utilityFloor**(`options`): [`Check`](../../../interfaces/Check.md)

Defined in: [checks.ts:294](https://github.com/Bubblegunn/proactive-gate/blob/e52b6351cb6a6bb88af985c199c03eaec6df967f/src/checks.ts#L294)

Expected-utility alerting: act only when the caller's estimate of acceptance
clears tau = cFA / (cFA + pNeed * cFN). That threshold is the classical Bayes
decision boundary between the cost of alerting when the user did not want it,
(1 - p) * cFA, and the cost of staying silent when they did, p * cFN.
The alerting application is Horvitz, Jacobs and Hovel, "Attention-Sensitive
Alerting", UAI 1999 (https://arxiv.org/abs/1301.6707); the system in that
paper is named Priorities.
`candidate.pAccept` and `candidate.pNeed` come from the caller's own model.

## Parameters

### options

#### costFalseAlarm

`number`

#### costMissedHelp

`number`

## Returns

[`Check`](../../../interfaces/Check.md)
