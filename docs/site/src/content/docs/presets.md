---
title: Presets
description: Platform quotas and legal limits as ordered check lists, each next to its source.
---

Reviewable defaults, not legal advice. Several official sources disagree with each other; every
preset carries a `note` on what it encodes and what it leaves out, and a `sources` list.

```ts
import { presets } from "proactive-gate/presets";
const gate = createGate({ checks: [checks.consent(), ...presets.usTcpa()] });
```

```json
{ "specVersion": "1.0.0", "checks": [{ "id": "consent" }, { "preset": "kakaoBrandMessage" }] }
```

| preset | checks | source |
|---|---|---|
| `lineMessagingApi({ plan })` | consent, monthly budget 200 / 5,000 / 30,000 by plan | LINE Messaging API pricing |
| `wechatSubscriptionMessage` | `consents.subscription`, one message per opt-in | WeChat subscribe-message overview |
| `wechatCustomerService` | inbound within 48 h, at most 5 in that window | WeChat customer-message send |
| `wechatTemplateMessage` | `consents.templateTrigger`, 3 templates a day | WeChat template message rules |
| `wecomAppMessage` | 30 a minute and 1,000 an hour per member | WeCom document 96212 |
| `kakaoAlimtalk` | consent | Kakao Business, AlimTalk |
| `kakaoBrandMessage` | `consents.ad`, 08:00 to 20:50 Asia/Seoul | Kakao Business, brand message |
| `krNetworkAct50` | `consents.ad`, `consents.night` for 21:00 to 08:00 local | Network Act article 50 |
| `jpAntiSpamLaw` | `consents.optIn` | MIC, anti-spam law |
| `cnMinorMode` | for `user.minor`: 06:00 to 22:00 Asia/Shanghai and one a day | CAC, 2022 and 2024 rules |
| `usTcpa` | 08:00 to 21:00 at the user's local time | 47 CFR 64.1200 |
| `euEprivacy` | `consents.marketing`, soft opt-in for `existingCustomer` | Directive 2002/58/EC art. 13 |
| `telegramBot` | 1 a second and 20 a minute per `candidate.channel` | Telegram bots FAQ |
| `slackApp` | 1 a second per `candidate.channel` | Slack rate limits |

The exact URLs are in
[`src/presets.ts`](https://github.com/Bubblegunn/proactive-gate/blob/main/src/presets.ts) and on
each preset's `sources` property at runtime.
