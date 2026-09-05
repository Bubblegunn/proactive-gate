"""Platform quotas and legal limits as ordered check lists, one to one with the
TypeScript presets. Reviewable defaults, not legal advice; every number sits
next to its source."""
from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from . import checks as c
from .checks import Check
from .types import Context, Outcome

Options = Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class Preset:
    build: Callable[[Options], list[Check]]
    sources: tuple[str, ...]
    note: str

    def __call__(self, options: Options | None = None) -> list[Check]:
        return self.build(options or {})


LINE_PLANS: dict[str, int] = {"communication": 200, "light": 5000, "standard": 30000}


def _line(o: Options) -> list[Check]:
    plan = o.get("plan", "communication")
    if plan not in LINE_PLANS:
        raise ValueError(f'lineMessagingApi: unknown plan "{plan}", known: {", ".join(LINE_PLANS)}')
    return [c.Consent(), c.MonthlyBudget(limit=LINE_PLANS[plan], near_limit=0.9)]


def _cn_minor_mode(o: Options) -> list[Check]:
    is_minor = lambda ctx: bool(ctx.user.minor)  # noqa: E731
    window = c.AllowedWindow("06:00", "22:00", "Asia/Shanghai", id="window:minor")
    return [c.OnlyWhen(window, is_minor, "not a minor"), c.OnlyWhen(c.DailyBudget(limit=1), is_minor, "not a minor")]


class _SoftOptIn(c.BaseCheck):
    id = "consent:marketing"

    def __init__(self) -> None:
        self.inner = c.RequiresConsent("marketing")

    def run(self, ctx: Context, values: Mapping[str, str | None]) -> Outcome:
        if ctx.user.existing_customer:
            return Outcome("pass", "existing customer, soft opt-in")
        return self.inner.run(ctx, values)


presets: dict[str, Preset] = {
    "lineMessagingApi": Preset(
        _line,
        ("https://developers.line.biz/en/docs/messaging-api/pricing/", "https://developers.line.biz/en/reference/messaging-api/"),
        "Monthly push messages per plan for Japan: communication 200, light 5,000, standard 30,000; replies are free and not counted. Multicast and broadcast request rates are not encoded.",
    ),
    "wechatSubscriptionMessage": Preset(
        lambda o: [c.RequiresConsent("subscription"), c.WindowBudget(limit=1, within_hours=24 * 365)],
        ("https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/subscribe-message-overview.html",),
        "One-time subscription: exactly one message per opt-in; set user.lastInboundAt to the opt-in instant. Long-term subscriptions for government, medical, transport, finance and education categories are not encoded.",
    ),
    "wechatCustomerService": Preset(
        lambda o: [c.RecentInteraction(within_hours=48), c.WindowBudget(limit=5, within_hours=48)],
        ("https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/customer-message/send.html",),
        "Mini program customer-service messages: within 48 hours of the user's last message, at most 5 in that window.",
    ),
    "wechatTemplateMessage": Preset(
        lambda o: [c.RequiresConsent("templateTrigger"), c.RateLimit(limit=3, per_seconds=24 * 3600, key_by="user", id="rate:template")],
        ("https://developers.weixin.qq.com/doc/service/guide/product/template_message/Template_Message_Operation_Specifications.html",),
        "Template messages only after a user action (consents.templateTrigger) and no more than three repeated templates a day; marketing templates are not allowed at all.",
    ),
    "wecomAppMessage": Preset(
        lambda o: [c.RateLimit(limit=30, per_seconds=60, id="rate:30/min"), c.RateLimit(limit=1000, per_seconds=3600, id="rate:1000/h")],
        ("https://developer.work.weixin.qq.com/document/path/96212",),
        "WeCom application messages per app per member: 30 a minute and 1,000 an hour; the platform drops the excess silently, this preset refuses it with a reason.",
    ),
    "kakaoAlimtalk": Preset(
        lambda o: [c.Consent()],
        ("https://kakaobusiness.gitbook.io/main/ad/infotalk",),
        "AlimTalk is informational and carries no time-of-day limit; consent is the only gate.",
    ),
    "kakaoBrandMessage": Preset(
        lambda o: [c.RequiresConsent("ad"), c.AllowedWindow("08:00", "20:50", "Asia/Seoul", id="window:kakao")],
        ("https://kakaobusiness.gitbook.io/main/ad/moment/messagead/channelmessage/new/send",),
        "Brand messages need advertising consent and go out 08:00 to 20:50 Korea time regardless of the recipient's location. Official sources also quote 20:00 and 20:55; 20:50 is the stricter documented value.",
    ),
    "krNetworkAct50": Preset(
        lambda o: [c.RequiresConsent("ad"), c.RequiresConsent("night", when={"start": "21:00", "end": "08:00", "timezone": "user"})],
        ("https://www.law.go.kr", "https://developers.fingerpush.com/biz-message/console/ads-guide"),
        "Network Act article 50: prior consent for advertising, and a separate consent for 21:00 to 08:00 (email is exempt). The two-year re-confirmation is not encoded.",
    ),
    "jpAntiSpamLaw": Preset(
        lambda o: [c.RequiresConsent("optIn")],
        ("https://www.soumu.go.jp/main_sosiki/cybersecurity/kokumin/basic/legal/08/",),
        "Opt-in since 2008 with sender identity and an opt-out route. There is no time-of-day rule in the law; a Japanese quiet-hours window would be etiquette, so none is encoded.",
    ),
    "cnMinorMode": Preset(
        _cn_minor_mode,
        ("https://www.cac.gov.cn/2024-11/15/c_1733364304749288.htm", "https://www.cac.gov.cn/2022-01/04/c_1642894606364259.htm"),
        "Minor mode: no service 22:00 to 06:00 China time and a daily budget of one when user.minor is true; adults pass both checks. Per-age daily durations are not encoded.",
    ),
    "usTcpa": Preset(
        lambda o: [c.AllowedWindow("08:00", "21:00", "user", id="window:tcpa")],
        ("https://www.law.cornell.edu/cfr/text/47/64.1200",),
        "47 CFR 64.1200: no solicitation before 8 a.m. or after 9 p.m. at the called party's local time.",
    ),
    "euEprivacy": Preset(
        lambda o: [_SoftOptIn()],
        ("https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32002L0058",),
        "Directive 2002/58/EC article 13: prior consent for direct marketing, with the soft opt-in for existing customers (user.existingCustomer).",
    ),
    "telegramBot": Preset(
        lambda o: [c.RateLimit(limit=1, per_seconds=1, key_by="channel", id="rate:1/s"), c.RateLimit(limit=20, per_seconds=60, key_by="channel", id="rate:20/min")],
        ("https://core.telegram.org/bots/faq",),
        "One message a second per chat and twenty a minute per group, keyed by candidate.channel. The broadcast rate of roughly thirty a second is not encoded.",
    ),
    "slackApp": Preset(
        lambda o: [c.RateLimit(limit=1, per_seconds=1, key_by="channel", id="rate:1/s")],
        ("https://docs.slack.dev/apis/web-api/rate-limits/",),
        "chat.postMessage: one message a second per channel, keyed by candidate.channel.",
    ),
}

__all__ = ["LINE_PLANS", "Preset", "presets"]
