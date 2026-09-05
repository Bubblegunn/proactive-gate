/**
 * Presets: the platform quotas and legal limits people ship against, as ordered
 * check lists. Reviewable defaults, not legal advice. Every number sits next to
 * its source; several official sources disagree with each other (the Kakao
 * evening boundary is quoted as 20:00, 20:50 and 20:55), so read the note and
 * decide for your own deployment.
 */
import * as c from "./checks.js";
import type { Check } from "./types.js";

export interface Preset {
  (options?: Record<string, unknown>): Check[];
  /** Primary sources the numbers come from. */
  sources: string[];
  /** What the preset encodes and what it leaves out. */
  note: string;
}

const define = (build: (options: Record<string, unknown>) => Check[], sources: string[], note: string): Preset => {
  const preset = ((options = {}) => build(options)) as Preset;
  preset.sources = sources;
  preset.note = note;
  return preset;
};

const LINE_PLANS: Record<string, number> = { communication: 200, light: 5000, standard: 30000 };

export const presets: Record<string, Preset> = {
  lineMessagingApi: define(
    (o) => {
      const plan = typeof o.plan === "string" ? o.plan : "communication";
      const limit = LINE_PLANS[plan];
      if (limit === undefined) throw new Error(`lineMessagingApi: unknown plan "${plan}", known: ${Object.keys(LINE_PLANS).join(", ")}`);
      return [c.consent(), c.monthlyBudget({ limit, nearLimit: 0.9 })];
    },
    ["https://developers.line.biz/en/docs/messaging-api/pricing/", "https://developers.line.biz/en/reference/messaging-api/"],
    "Monthly push messages per plan for Japan: communication 200, light 5,000, standard 30,000; replies are free and not counted. Multicast and broadcast request rates are not encoded.",
  ),
  wechatSubscriptionMessage: define(
    () => [c.requiresConsent({ name: "subscription" }), c.windowBudget({ limit: 1, withinHours: 24 * 365 })],
    ["https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/subscribe-message-overview.html"],
    "One-time subscription: exactly one message per opt-in; set user.lastInboundAt to the opt-in instant. Long-term subscriptions for government, medical, transport, finance and education categories are not encoded.",
  ),
  wechatCustomerService: define(
    () => [c.recentInteraction({ withinHours: 48 }), c.windowBudget({ limit: 5, withinHours: 48 })],
    ["https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/customer-message/send.html"],
    "Mini program customer-service messages: within 48 hours of the user's last message, at most 5 in that window.",
  ),
  wechatTemplateMessage: define(
    () => [c.requiresConsent({ name: "templateTrigger" }), c.rateLimit({ limit: 3, perSeconds: 24 * 3600, keyBy: "user", id: "rate:template" })],
    ["https://developers.weixin.qq.com/doc/service/guide/product/template_message/Template_Message_Operation_Specifications.html"],
    "Template messages only after a user action (consents.templateTrigger) and no more than three repeated templates a day; marketing templates are not allowed at all.",
  ),
  wecomAppMessage: define(
    () => [c.rateLimit({ limit: 30, perSeconds: 60, id: "rate:30/min" }), c.rateLimit({ limit: 1000, perSeconds: 3600, id: "rate:1000/h" })],
    ["https://developer.work.weixin.qq.com/document/path/96212"],
    "WeCom application messages per app per member: 30 a minute and 1,000 an hour; the platform drops the excess silently, this preset refuses it with a reason.",
  ),
  kakaoAlimtalk: define(
    () => [c.consent()],
    ["https://kakaobusiness.gitbook.io/main/ad/infotalk"],
    "AlimTalk is informational and carries no time-of-day limit; consent is the only gate.",
  ),
  kakaoBrandMessage: define(
    () => [c.requiresConsent({ name: "ad" }), c.allowedWindow({ start: "08:00", end: "20:50", timezone: "Asia/Seoul", id: "window:kakao" })],
    ["https://kakaobusiness.gitbook.io/main/ad/moment/messagead/channelmessage/new/send"],
    "Brand messages need advertising consent and go out 08:00 to 20:50 Korea time regardless of the recipient's location. Official sources also quote 20:00 and 20:55; 20:50 is the stricter documented value.",
  ),
  krNetworkAct50: define(
    () => [c.requiresConsent({ name: "ad" }), c.requiresConsent({ name: "night", when: { start: "21:00", end: "08:00", timezone: "user" } })],
    ["https://www.law.go.kr", "https://developers.fingerpush.com/biz-message/console/ads-guide"],
    "Network Act article 50: prior consent for advertising, and a separate consent for 21:00 to 08:00 (email is exempt). The two-year re-confirmation is not encoded.",
  ),
  jpAntiSpamLaw: define(
    () => [c.requiresConsent({ name: "optIn" })],
    ["https://www.soumu.go.jp/main_sosiki/cybersecurity/kokumin/basic/legal/08/"],
    "Opt-in since 2008 with sender identity and an opt-out route. There is no time-of-day rule in the law; a Japanese quiet-hours window would be etiquette, so none is encoded.",
  ),
  cnMinorMode: define(
    () => {
      const window = c.allowedWindow({ start: "06:00", end: "22:00", timezone: "Asia/Shanghai", id: "window:minor" });
      const budget = c.dailyBudget({ limit: 1 });
      const adult: Check["run"] = () => ({ kind: "pass", reason: "not a minor" });
      return [
        { id: window.id, run: (ctx) => (ctx.user.minor ? window.run(ctx) : adult(ctx)) },
        { id: budget.id, limit: budget.limit, run: (ctx) => (ctx.user.minor ? budget.run(ctx) : adult(ctx)), consume: (ctx) => (ctx.user.minor ? budget.consume(ctx) : Promise.resolve(true)) },
      ];
    },
    ["https://www.cac.gov.cn/2024-11/15/c_1733364304749288.htm", "https://www.cac.gov.cn/2022-01/04/c_1642894606364259.htm"],
    "Minor mode: no service 22:00 to 06:00 China time and a daily budget of one when user.minor is true; adults pass both checks. Per-age daily durations are not encoded.",
  ),
  usTcpa: define(
    () => [c.allowedWindow({ start: "08:00", end: "21:00", timezone: "user", id: "window:tcpa" })],
    ["https://www.law.cornell.edu/cfr/text/47/64.1200"],
    "47 CFR 64.1200: no solicitation before 8 a.m. or after 9 p.m. at the called party's local time.",
  ),
  euEprivacy: define(
    () => [{ ...c.requiresConsent({ name: "marketing" }), run: (ctx) => (ctx.user.existingCustomer ? { kind: "pass", reason: "existing customer, soft opt-in" } : c.requiresConsent({ name: "marketing" }).run(ctx)) }],
    ["https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32002L0058"],
    "Directive 2002/58/EC article 13: prior consent for direct marketing, with the soft opt-in for existing customers (user.existingCustomer).",
  ),
  telegramBot: define(
    () => [c.rateLimit({ limit: 1, perSeconds: 1, keyBy: "channel", id: "rate:1/s" }), c.rateLimit({ limit: 20, perSeconds: 60, keyBy: "channel", id: "rate:20/min" })],
    ["https://core.telegram.org/bots/faq"],
    "One message a second per chat and twenty a minute per group, keyed by candidate.channel. The broadcast rate of roughly thirty a second is not encoded.",
  ),
  slackApp: define(
    () => [c.rateLimit({ limit: 1, perSeconds: 1, keyBy: "channel", id: "rate:1/s" })],
    ["https://docs.slack.dev/apis/web-api/rate-limits/"],
    "chat.postMessage: one message a second per channel, keyed by candidate.channel.",
  ),
};
