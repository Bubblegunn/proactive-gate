package proactivegate

import (
	"fmt"
	"sort"
)

// A Preset is a platform quota or legal limit as an ordered check list. Every
// number sits next to its source in the preset's note; these are reviewable
// defaults, not legal advice.
type Preset struct {
	// Build expands the preset to its ordered checks.
	Build func(options map[string]any) ([]Check, error)
	// Sources are the primary sources the numbers come from.
	Sources []string
	// Note says what the preset encodes and what it leaves out.
	Note string
}

var linePlans = map[string]int64{"communication": 200, "light": 5000, "standard": 30000}

func must(c Check, err error) Check {
	if err != nil {
		panic(err) // unreachable: presets pass compile-time constants
	}
	return c
}

// Presets is the vocabulary a JSON policy may name under "preset" (7.2).
var Presets = map[string]Preset{
	"lineMessagingApi": {
		Build: func(o map[string]any) ([]Check, error) {
			plan := "communication"
			if s, ok := o["plan"].(string); ok {
				plan = s
			}
			limit, ok := linePlans[plan]
			if !ok {
				names := make([]string, 0, len(linePlans))
				for k := range linePlans {
					names = append(names, k)
				}
				sort.Strings(names)
				return nil, fmt.Errorf("lineMessagingApi: unknown plan %q, known: %v", plan, names)
			}
			return []Check{consent(), monthlyBudget(budgetOptions{Limit: limit, NearLimit: 0.9})}, nil
		},
		Sources: []string{"https://developers.line.biz/en/docs/messaging-api/pricing/", "https://developers.line.biz/en/reference/messaging-api/"},
		Note:    "Monthly push messages per plan for Japan: communication 200, light 5,000, standard 30,000; replies are free and not counted. Multicast and broadcast request rates are not encoded.",
	},
	"wechatSubscriptionMessage": {
		Build: func(o map[string]any) ([]Check, error) {
			return []Check{
				must(requiresConsent("subscription", nil, "", "")),
				windowBudget(1, 24*365),
			}, nil
		},
		Sources: []string{"https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/subscribe-message-overview.html"},
		Note:    "One-time subscription: exactly one message per opt-in; set user.lastInboundAt to the opt-in instant. Long-term subscriptions for government, medical, transport, finance and education categories are not encoded.",
	},
	"wechatCustomerService": {
		Build: func(o map[string]any) ([]Check, error) {
			return []Check{recentInteraction(48), windowBudget(5, 48)}, nil
		},
		Sources: []string{"https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/customer-message/send.html"},
		Note:    "Mini program customer-service messages: within 48 hours of the user's last message, at most 5 in that window.",
	},
	"wechatTemplateMessage": {
		Build: func(o map[string]any) ([]Check, error) {
			return []Check{
				must(requiresConsent("templateTrigger", nil, "", "")),
				rateLimit(3, 24*3600, "user", "rate:template"),
			}, nil
		},
		Sources: []string{"https://developers.weixin.qq.com/doc/service/guide/product/template_message/Template_Message_Operation_Specifications.html"},
		Note:    "Template messages only after a user action (consents.templateTrigger) and no more than three repeated templates a day; marketing templates are not allowed at all.",
	},
	"wecomAppMessage": {
		Build: func(o map[string]any) ([]Check, error) {
			return []Check{
				rateLimit(30, 60, "", "rate:30/min"),
				rateLimit(1000, 3600, "", "rate:1000/h"),
			}, nil
		},
		Sources: []string{"https://developer.work.weixin.qq.com/document/path/96212"},
		Note:    "WeCom application messages per app per member: 30 a minute and 1,000 an hour; the platform drops the excess silently, this preset refuses it with a reason.",
	},
	"kakaoAlimtalk": {
		Build: func(o map[string]any) ([]Check, error) {
			return []Check{consent()}, nil
		},
		Sources: []string{"https://kakaobusiness.gitbook.io/main/ad/infotalk"},
		Note:    "AlimTalk is informational and carries no time-of-day limit; consent is the only gate.",
	},
	"kakaoBrandMessage": {
		Build: func(o map[string]any) ([]Check, error) {
			return []Check{
				must(requiresConsent("ad", nil, "", "")),
				must(allowedWindow("08:00", "20:50", "Asia/Seoul", "", "window:kakao")),
			}, nil
		},
		Sources: []string{"https://kakaobusiness.gitbook.io/main/ad/moment/messagead/channelmessage/new/send"},
		Note:    "Brand messages need advertising consent and go out 08:00 to 20:50 Korea time regardless of the recipient's location. Official sources also quote 20:00 and 20:55; 20:50 is the stricter documented value.",
	},
	"krNetworkAct50": {
		Build: func(o map[string]any) ([]Check, error) {
			return []Check{
				must(requiresConsent("ad", nil, "", "")),
				must(requiresConsent("night", &QuietWindow{Start: "21:00", End: "08:00"}, "user", "")),
			}, nil
		},
		Sources: []string{"https://www.law.go.kr", "https://developers.fingerpush.com/biz-message/console/ads-guide"},
		Note:    "Network Act article 50: prior consent for advertising, and a separate consent for 21:00 to 08:00 (email is exempt). Without user.timezone the night consent cannot be placed in the day and skips; the advertising consent still applies. The two-year re-confirmation is not encoded.",
	},
	"jpAntiSpamLaw": {
		Build: func(o map[string]any) ([]Check, error) {
			return []Check{must(requiresConsent("optIn", nil, "", ""))}, nil
		},
		Sources: []string{"https://www.soumu.go.jp/main_sosiki/cybersecurity/kokumin/basic/legal/08/"},
		Note:    "Opt-in since 2008 with sender identity and an opt-out route. There is no time-of-day rule in the law; a Japanese quiet-hours window would be etiquette, so none is encoded.",
	},
	"cnMinorMode": {
		Build: func(o map[string]any) ([]Check, error) {
			window := must(allowedWindow("06:00", "22:00", "Asia/Shanghai", "", "window:minor"))
			budg := dailyBudget(budgetOptions{Limit: 1})
			adult := func(ctx *CheckContext) (Outcome, error) {
				return passReason("not a minor"), nil
			}
			return []Check{
				{
					ID: window.ID,
					Run: func(ctx *CheckContext) (Outcome, error) {
						if ctx.User.Minor {
							return window.Run(ctx)
						}
						return adult(ctx)
					},
				},
				{
					ID: budg.ID,
					Run: func(ctx *CheckContext) (Outcome, error) {
						if ctx.User.Minor {
							return budg.Run(ctx)
						}
						return adult(ctx)
					},
					Consume: func(ctx *CheckContext) (bool, error) {
						if ctx.User.Minor {
							return budg.Consume(ctx)
						}
						return true, nil
					},
				},
			}, nil
		},
		Sources: []string{"https://www.cac.gov.cn/2024-11/15/c_1733364304749288.htm", "https://www.cac.gov.cn/2022-01/04/c_1642894606364259.htm"},
		Note:    "Minor mode: no service 22:00 to 06:00 China time and a daily budget of one when user.minor is true; adults pass both checks. Per-age daily durations are not encoded.",
	},
	// India: TCCCPR 2018 (6 of 2018). Regulation 9 lets a commercial
	// communication reach a recipient only per the recipient's registered
	// preference or consent; Schedule-II item 3 fixes nine time bands and keeps
	// (i) 00:00-06:00, (ii) 06:00-08:00, (iii) 08:00-10:00 and (ix) 21:00-24:00
	// default OFF for every customer until the subscriber switches that band
	// on, which the four band flags below carry.
	"inTcccp": {
		Build: func(o map[string]any) ([]Check, error) {
			return []Check{
				must(requiresConsent("promotional", nil, "", "")),
				must(requiresConsent("band00to06", &QuietWindow{Start: "00:00", End: "06:00"}, "user", "")),
				must(requiresConsent("band06to08", &QuietWindow{Start: "06:00", End: "08:00"}, "user", "")),
				must(requiresConsent("band08to10", &QuietWindow{Start: "08:00", End: "10:00"}, "user", "")),
				must(requiresConsent("band21to24", &QuietWindow{Start: "21:00", End: "24:00"}, "user", "")),
			}, nil
		},
		Sources: []string{"https://trai.gov.in/tcccpr", "https://www.trai.gov.in/sites/default/files/2025-01/RegulationUcc19072018.pdf", "https://www.trai.gov.in/sites/default/files/2026-05/CA_21052026.pdf"},
		Note:    "TCCCPR 2018: commercial communication needs the recipient's registered preference or consent (consents.promotional), and the Schedule-II default-off bands pass only when the subscriber opted that band in (the consents.band* flags, at the recipient's local time). The preference machinery is about promotional communication: the regulation's own block options exempt transactional and service communication and government communication (Schedule-II item 1 Note-4, item 3 Note-4), so pointing this preset at a transactional message imports a restriction the regulation does not place on it. Without user.timezone the four band checks skip and only the promotional consent is left. Opt-outs inside the default-on 10:00 to 21:00, day-type and per-category preferences are per-subscriber state a fixed check list cannot express; carry them in user.quietHours and consents. It binds SMS and voice calls on access networks, not in-app notifications or email; 1909 and DLT registration are out of scope.",
	},
	// Brazil: Lei 13.709/2018 (LGPD), as amended by Lei 13.853/2019. Marketing
	// to a person is processing of their personal data, so it needs a basis
	// under art. 7; consent (art. 7, I) is the one a send-time gate can verify.
	// For a child the consent is the parent's: art. 14, paragraph 1 requires
	// specific, highlighted consent from at least one parent or legal guardian,
	// so a user.minor additionally needs consents.parental.
	"brLgpd": {
		Build: func(o map[string]any) ([]Check, error) {
			parental := must(requiresConsent("parental", nil, "", ""))
			adult := func(ctx *CheckContext) (Outcome, error) {
				return passReason("not a minor"), nil
			}
			return []Check{
				must(requiresConsent("marketing", nil, "", "")),
				{
					ID: parental.ID,
					Run: func(ctx *CheckContext) (Outcome, error) {
						if ctx.User.Minor {
							return parental.Run(ctx)
						}
						return adult(ctx)
					},
				},
			}, nil
		},
		Sources: []string{
			"https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm",
			"https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia_legitimo_interesse.pdf",
			"https://bibliotecadigital.mj.gov.br/handle/1/10215",
		},
		Note: "Lei 13.709/2018: marketing to a person is processing of their personal data and needs a legal basis; consent (art. 7, I) is the one a send-time check can verify, carried as consents.marketing because art. 8, paragraph 4 voids a generic authorization and paragraph 5 keeps it revocable at any time by a free and facilitated procedure. A child's consent comes from at least one parent or legal guardian (art. 14, paragraph 1), which consents.parental carries when user.minor is set; the flag cannot tell a child from an adolescent, and ANPD Enunciado CD/ANPD 1/2023 reads art. 14 as allowing any art. 7 or art. 11 basis for children and adolescents alike under the best-interest rule, so consent is not the only available basis for either group. The parental gate for every minor is stricter than that reading, which is the deliberate call for a gate. Unlike Directive 2002/58/EC art. 13(2) there is no soft opt-in for existing customers, and legitimate interest (art. 7, IX; art. 10) needs a documented balancing test, so if that is the basis, this preset is not the thing that decides the send. The law sets no quiet window, so none is encoded.",
	},
	"usTcpa": {
		Build: func(o map[string]any) ([]Check, error) {
			return []Check{must(allowedWindow("08:00", "21:00", "user", "", "window:tcpa"))}, nil
		},
		Sources: []string{"https://www.law.cornell.edu/cfr/text/47/64.1200"},
		Note:    "47 CFR 64.1200: no solicitation before 8 a.m. or after 9 p.m. at the called party's local time. Without user.timezone there is no local time to compare, so the check skips and the caller is not covered.",
	},
	"euEprivacy": {
		Build: func(o map[string]any) ([]Check, error) {
			marketing := must(requiresConsent("marketing", nil, "", ""))
			return []Check{
				{
					ID: marketing.ID,
					Run: func(ctx *CheckContext) (Outcome, error) {
						if ctx.User.ExistingCustomer {
							return passReason("existing customer, soft opt-in"), nil
						}
						return marketing.Run(ctx)
					},
				},
			}, nil
		},
		Sources: []string{"https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32002L0058"},
		Note:    "Directive 2002/58/EC article 13: prior consent for direct marketing, with the soft opt-in for existing customers (user.existingCustomer).",
	},
	"telegramBot": {
		Build: func(o map[string]any) ([]Check, error) {
			return []Check{
				rateLimit(1, 1, "channel", "rate:1/s"),
				rateLimit(20, 60, "channel", "rate:20/min"),
			}, nil
		},
		Sources: []string{"https://core.telegram.org/bots/faq"},
		Note:    "One message a second per chat and twenty a minute per group, keyed by candidate.channel. The broadcast rate of roughly thirty a second is not encoded.",
	},
	"slackApp": {
		Build: func(o map[string]any) ([]Check, error) {
			return []Check{rateLimit(1, 1, "channel", "rate:1/s")}, nil
		},
		Sources: []string{"https://docs.slack.dev/apis/web-api/rate-limits/"},
		Note:    "chat.postMessage: one message a second per channel, keyed by candidate.channel.",
	},
	// WhatsApp Business Platform. Meta requires opt-in before a business
	// messages a user at all. A free-form service message may only be sent
	// inside the 24-hour customer service window the user's last message or
	// call opened; outside it only pre-approved template messages are allowed,
	// so { template: true } drops the window check for that path.
	"whatsappBusiness": {
		Build: func(o map[string]any) ([]Check, error) {
			checks := []Check{must(requiresConsent("whatsappOptIn", nil, "", ""))}
			if o["template"] != true {
				checks = append(checks, recentInteraction(24))
			}
			checks = append(checks, rateLimit(600, 3600, "user", "rate:waPair"))
			return checks, nil
		},
		Sources: []string{
			"https://developers.facebook.com/docs/whatsapp/overview/getting-opt-in/",
			"https://developers.facebook.com/docs/whatsapp/conversation-types/",
			"https://developers.facebook.com/docs/whatsapp/overview/",
			"https://developers.facebook.com/docs/whatsapp/messaging-limits/",
			"https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/marketing-templates/per-user-limits",
		},
		Note: "WhatsApp Business Platform: the recipient's opt-in is required before any business message (consents.whatsappOptIn), and a free-form service message may be sent only inside the 24-hour customer service window the user's last message or call opened (user.lastInboundAt; each inbound resets it). Pass { template: true } for an approved template message, the only kind allowed outside the window; template approval is out of scope. The pair rate limit is encoded as 600 messages an hour to the same user, the sustained bound Meta documents; the real mechanism is a six-second bucket that also allows a 45-message burst, which a fixed window cannot express; the approximation errs looser, since a 3,600-second bucket lets all 600 leave in the first second and turns over at a fixed boundary rather than a moving one, so it is inside-the-hour looser than the platform and boundary-looser still. Not encoded: the business portfolio messaging limit (250 unique recipient phone numbers per moving 24 hours, rising to 2,000, 10,000, 100,000 or unlimited by quality-based scaling), because it counts distinct recipients sender-side rather than messages; the per-user marketing template cap, for which Meta publishes no number; the current non-delivery of marketing templates to +1 numbers and the EEA, UK, Japan and Korea exclusions; and free entry point windows, which change pricing rather than permission.",
	},
}
