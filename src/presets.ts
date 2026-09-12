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
    "Network Act article 50: prior consent for advertising, and a separate consent for 21:00 to 08:00 (email is exempt). Without user.timezone the night consent cannot be placed in the day and skips; the advertising consent still applies. The two-year re-confirmation is not encoded.",
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
  // India: TCCCPR 2018 (6 of 2018). Regulation 9 lets a commercial communication reach a
  // recipient only per the recipient's registered preference or consent; Schedule-II item 3
  // fixes nine time bands and keeps (i) 00:00-06:00, (ii) 06:00-08:00, (iii) 08:00-10:00
  // and (ix) 21:00-24:00 default OFF for every customer until the subscriber switches that
  // band on, which the four band flags below carry. The second source is the gazetted
  // regulation and the third is the May 2026 consolidation, which says on its own first
  // page that the gazetted text prevails where they differ. Read 2026-09-12.
  inTcccp: define(
    () => [
      c.requiresConsent({ name: "promotional" }),
      c.requiresConsent({ name: "band00to06", when: { start: "00:00", end: "06:00", timezone: "user" } }),
      c.requiresConsent({ name: "band06to08", when: { start: "06:00", end: "08:00", timezone: "user" } }),
      c.requiresConsent({ name: "band08to10", when: { start: "08:00", end: "10:00", timezone: "user" } }),
      c.requiresConsent({ name: "band21to24", when: { start: "21:00", end: "24:00", timezone: "user" } }),
    ],
    ["https://trai.gov.in/tcccpr", "https://www.trai.gov.in/sites/default/files/2025-01/RegulationUcc19072018.pdf", "https://www.trai.gov.in/sites/default/files/2026-05/CA_21052026.pdf"],
    "TCCCPR 2018: commercial communication needs the recipient's registered preference or consent (consents.promotional), and the Schedule-II default-off bands pass only when the subscriber opted that band in (the consents.band* flags, at the recipient's local time). The preference machinery is about promotional communication: the regulation's own block options exempt transactional and service communication and government communication (Schedule-II item 1 Note-4, item 3 Note-4), so pointing this preset at a transactional message imports a restriction the regulation does not place on it. Without user.timezone the four band checks skip and only the promotional consent is left. Opt-outs inside the default-on 10:00 to 21:00, day-type and per-category preferences are per-subscriber state a fixed check list cannot express; carry them in user.quietHours and consents. It binds SMS and voice calls on access networks, not in-app notifications or email; 1909 and DLT registration are out of scope. Sources read 2026-09-12.",
  ),
  // Brazil: Lei 13.709/2018 (LGPD), as amended by Lei 13.853/2019. Marketing to a
  // person is processing of their personal data, so it needs a basis under art.
  // 7; consent (art. 7, I) is the one a send-time gate can verify, and art. 8
  // ties it to determined purposes, paragraph 4 voiding a generic authorization,
  // and keeps it revocable at any time through a free and facilitated procedure
  // (paragraph 5), which is why the flag is a named marketing consent read at
  // every send. For a child the consent is the parent's: art. 14, paragraph 1
  // requires specific, highlighted consent from at least one parent or legal
  // guardian, so a user.minor additionally needs consents.parental. Read
  // 2026-09-12.
  brLgpd: define(
    () => {
      const parental = c.requiresConsent({ name: "parental" });
      const adult: Check["run"] = () => ({ kind: "pass", reason: "not a minor" });
      return [
        c.requiresConsent({ name: "marketing" }),
        { id: parental.id, run: (ctx) => (ctx.user.minor ? parental.run(ctx) : adult(ctx)) },
      ];
    },
    [
      "https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm",
      "https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia_legitimo_interesse.pdf",
      "https://bibliotecadigital.mj.gov.br/handle/1/10215",
    ],
    "Lei 13.709/2018: marketing to a person is processing of their personal data and needs a legal basis; consent (art. 7, I) is the one a send-time check can verify, carried as consents.marketing because art. 8, paragraph 4 voids a generic authorization and paragraph 5 keeps it revocable at any time by a free and facilitated procedure. A child's consent comes from at least one parent or legal guardian (art. 14, paragraph 1), which consents.parental carries when user.minor is set; the flag cannot tell a child from an adolescent, and ANPD Enunciado CD/ANPD 1/2023 reads art. 14 as allowing any art. 7 or art. 11 basis for children and adolescents alike under the best-interest rule, so consent is not the only available basis for either group. The parental gate for every minor is stricter than that reading, which is the deliberate call for a gate. Unlike Directive 2002/58/EC art. 13(2) there is no soft opt-in for existing customers, and legitimate interest (art. 7, IX; art. 10) needs a documented balancing test, so if that is the basis, this preset is not the thing that decides the send. The law sets no quiet window, so none is encoded. Sources read 2026-09-12.",
  ),
  usTcpa: define(
    () => [c.allowedWindow({ start: "08:00", end: "21:00", timezone: "user", id: "window:tcpa" })],
    ["https://www.law.cornell.edu/cfr/text/47/64.1200"],
    "47 CFR 64.1200: no solicitation before 8 a.m. or after 9 p.m. at the called party's local time. Without user.timezone there is no local time to compare, so the check skips and the caller is not covered.",
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
  // WhatsApp Business Platform. Meta requires opt-in before a business messages a
  // user at all. A free-form service message may only be sent inside the 24-hour
  // customer service window the user's last message or call opened; outside it
  // only pre-approved template messages are allowed, so { template: true } drops
  // the window check for that path. The pair rate limit is one message every six
  // seconds to the same user with a 45-message burst that borrows quota; 600 an
  // hour is the sustained bound Meta documents, and the bound a fixed window can
  // express. Read 2026-09-12.
  whatsappBusiness: define(
    (o) => [
      c.requiresConsent({ name: "whatsappOptIn" }),
      ...(o.template === true ? [] : [c.recentInteraction({ withinHours: 24 })]),
      c.rateLimit({ limit: 600, perSeconds: 3600, keyBy: "user", id: "rate:waPair" }),
    ],
    [
      "https://developers.facebook.com/docs/whatsapp/overview/getting-opt-in/",
      "https://developers.facebook.com/docs/whatsapp/conversation-types/",
      "https://developers.facebook.com/docs/whatsapp/overview/",
      "https://developers.facebook.com/docs/whatsapp/messaging-limits/",
      "https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/marketing-templates/per-user-limits",
    ],
    "WhatsApp Business Platform: the recipient's opt-in is required before any business message (consents.whatsappOptIn), and a free-form service message may be sent only inside the 24-hour customer service window the user's last message or call opened (user.lastInboundAt; each inbound resets it). Pass { template: true } for an approved template message, the only kind allowed outside the window; template approval is out of scope. The pair rate limit is encoded as 600 messages an hour to the same user, the sustained bound Meta documents; the real mechanism is a six-second bucket that also allows a 45-message burst, which a fixed window cannot express; the approximation errs looser, since a 3,600-second bucket lets all 600 leave in the first second and turns over at a fixed boundary rather than a moving one, so it is inside-the-hour looser than the platform and boundary-looser still. Not encoded: the business portfolio messaging limit (250 unique recipient phone numbers per moving 24 hours, rising to 2,000, 10,000, 100,000 or unlimited by quality-based scaling), because it counts distinct recipients sender-side rather than messages; the per-user marketing template cap, for which Meta publishes no number; the current non-delivery of marketing templates to +1 numbers and the EEA, UK, Japan and Korea exclusions; and free entry point windows, which change pricing rather than permission. Sources read 2026-09-12.",
  ),
};
