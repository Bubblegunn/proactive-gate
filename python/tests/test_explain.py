"""explain(): the same sentences as the TypeScript catalog, word for word."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest

from proactive_gate import (
    EN,
    Candidate,
    Decision,
    EvaluateInput,
    Gate,
    MemoryStore,
    TraceEntry,
    UserState,
    checks,
    explain,
)
from proactive_gate.types import QuietSchedule, QuietWindow

UTC = timezone.utc
NOON = datetime(2026, 9, 4, 9, 0, tzinfo=UTC)  # 12:00 in Istanbul (UTC+3)
NIGHT = datetime(2026, 9, 4, 20, 30, tzinfo=UTC)  # 23:30 in Istanbul


def user(**overrides: Any) -> UserState:
    base: dict[str, Any] = {
        "id": "u1",
        "consent": True,
        "proactive_enabled": True,
        "mode": "normal",
        "intensity": "normal",
        "timezone": "Europe/Istanbul",
        "quiet_hours": QuietWindow("22:00", "08:00"),
        "created_at": datetime(2026, 1, 1, tzinfo=UTC),
    }
    base.update(overrides)
    return UserState(**base)


def candidate(**overrides: Any) -> Candidate:
    base: dict[str, Any] = {"id": "c1", "type": "reminder", "priority": "normal", "surfaces": ("push", "feed")}
    base.update(overrides)
    return Candidate(**base)


def evaluate(checks_list: Any, u: UserState | None = None, c: Candidate | None = None, now: datetime = NOON, store: MemoryStore | None = None, **gate_kw: Any) -> Decision:
    gate = Gate(checks_list, store=store or MemoryStore(), **gate_kw)
    return gate.evaluate(EvaluateInput(u or user(), c or candidate(), now))


def test_pure_function_of_the_decision() -> None:
    d = evaluate(checks.default_checks(), now=NIGHT)
    first = explain(d)
    second = explain(d)
    assert first == second


def test_plain_sentence_and_machine_reason_are_both_on_hand() -> None:
    d = evaluate([checks.QuietHours()], now=NIGHT)
    e = explain(d)
    assert d.reason == "quiet hours 22:00 to 08:00 Europe/Istanbul; priority normal is below the floor (critical)"
    assert e.summary == "Held until 08:00 because the user's quiet hours run 22:00 to 08:00 Europe/Istanbul and normal priority is below the critical floor needed to override them."


def test_not_stopped_every_check_gets_a_sentence() -> None:
    d = evaluate(checks.default_checks(), now=NOON)
    e = explain(d)
    assert e.summary == "Allowed at 2026-09-04T09:00:00.000Z because no check stopped it."
    assert [c.id for c in e.checks] == [t.id for t in d.trace]
    assert all(c.sentence for c in e.checks)


def test_kill_switch() -> None:
    d = evaluate([checks.KillSwitch(True)], now=NOON)
    assert explain(d).summary == "Held because the kill switch is on, which stops every message."


@pytest.mark.parametrize(
    ("overrides", "clause"),
    [
        ({"consent": False}, "the user has not agreed to proactive messages"),
        ({"proactive_enabled": False}, "proactive messages are switched off on this user's profile"),
        ({"mode": "focus"}, 'the user\'s operating mode is "focus", which does not allow proactive messages'),
        ({"muted_types": ("reminder",)}, 'the user has muted "reminder" messages'),
    ],
)
def test_preference_checks_name_what_the_user_set(overrides: dict[str, Any], clause: str) -> None:
    d = evaluate(checks.default_checks(), u=user(**overrides), now=NOON)
    assert explain(d).summary == f"Held because {clause}."


def test_snooze_reject_and_defer() -> None:
    d = evaluate([checks.Snooze()], u=user(snoozed_until=datetime(2026, 9, 4, 12, 0, tzinfo=UTC)), now=NOON)
    assert explain(d).summary == "Held because the user has snoozed the assistant until 2026-09-04T12:00:00.000Z."
    deferred = evaluate([checks.Snooze(defer=True)], u=user(snoozed_until=datetime(2026, 9, 4, 12, 0, tzinfo=UTC)), now=NOON)
    assert deferred.deferred_by == "snooze"
    assert explain(deferred).summary == "Held because the user has snoozed the assistant until 2026-09-04T12:00:00.000Z."


def test_intensity() -> None:
    d = evaluate([checks.Intensity()], u=user(intensity="low"), now=NOON)
    assert explain(d).summary == 'Held because the message was normal priority, and the user\'s "low" intensity setting allows only high and above.'


def test_quiet_hours_window_owned_by_yesterday_says_so() -> None:
    # Friday's 18:00 to 06:00 window is what silences Saturday 00:30 local.
    scheduled = user(quiet_hours=QuietSchedule(default=None, days={"fri": QuietWindow("18:00", "06:00")}))
    d = evaluate([checks.QuietHours()], u=scheduled, now=datetime(2026, 9, 4, 21, 30, tzinfo=UTC))
    assert d.rejected_by == "quietHours"
    assert "a window belonging to fri 2026-09-04" in explain(d).summary


def test_quiet_hours_skip_without_timezone() -> None:
    d = evaluate([checks.QuietHours()], u=user(timezone=None), now=NIGHT)
    assert explain(d).checks[0].sentence == "The user has quiet hours but no time zone, so the check could not run."


def test_trust_ramp_names_the_day() -> None:
    d = evaluate([checks.TrustRamp()], u=user(created_at=datetime(2026, 9, 2, tzinfo=UTC)), now=NOON)
    assert explain(d).summary == "Held because the user is on day 3 of a 7-day trust period for new users, which allows only high priority and above, and the message was normal."
    skip = evaluate([checks.TrustRamp()], u=user(created_at=None), now=NOON)
    assert explain(skip).checks[0].sentence == "The user's sign-up date is not on record, so the new-user trust period could not be checked."


def test_dismissal_cooldown_said_plainly() -> None:
    store = MemoryStore()
    gate = Gate([checks.DismissalCooldown()], store=store)
    u = user()
    for day in (1, 2, 3):
        gate.record(u, Candidate(id=f"c{day}", type="reminder"), "dismissed", datetime(2026, 9, day, 10, 0, tzinfo=UTC))
    d = gate.evaluate(EvaluateInput(u, candidate(), datetime(2026, 9, 5, 10, 0, tzinfo=UTC)))
    assert explain(d).summary == 'Held because the user has dismissed "reminder" messages 3 times in 30 days, so this type stays silent until 2026-09-10T10:00:00.000Z.'


def test_adaptive_timing_adjust() -> None:
    d = evaluate(
        [checks.AdaptiveTiming(next_good_moment=lambda ctx: datetime(2026, 9, 4, 10, 0, tzinfo=UTC), surfaces_for=lambda ctx: ("feed",))],
        now=NOON,
    )
    assert d.allowed
    e = explain(d)
    assert e.checks[0].sentence == "Delivery was moved to 2026-09-04T10:00:00.000Z and narrowed to feed."
    assert "delivery waits until 2026-09-04T10:00:00.000Z" in e.summary


def test_budget_spent_at_send_time() -> None:
    store = MemoryStore()
    gate = Gate([checks.DailyBudget(limit=5), checks.WeeklyBudget(limit=20)], store=store)
    store.set("pg:budget:u1:2026-09-04", "4")
    near = gate.evaluate(EvaluateInput(user(), candidate(), NOON))
    e = explain(near)
    assert e.checks[0].sentence == "The daily budget had room, but only just: 4 of 5 already used; the unit is spent when the message actually goes out."
    assert "dailyBudget was close to its limit (4 of 5 used)" in e.summary

    store.set("pg:budget:u1:2026-09-04", "5")
    out = gate.evaluate(EvaluateInput(user(), candidate(), NOON))
    assert explain(out).summary == "Held because the user's daily budget of 5 was already spent (5 used)."


def test_rate_limit_custom_id() -> None:
    store = MemoryStore()
    window = int(NOON.timestamp() // 60)
    store.set(f"pg:rate:channel:general:60:{window}", "20")
    d = evaluate([checks.RateLimit(limit=20, per_seconds=60, key_by="channel", id="rate:20/min")], c=candidate(channel="general"), store=store, now=NOON)
    assert explain(d).summary == "Held because the rate limit of 20 messages per minute was already reached (20 used)."


@pytest.mark.parametrize(
    ("per_seconds", "limit", "said"),
    [(60, 20, "per minute"), (3600, 1000, "per hour"), (24 * 3600, 3, "per day"), (7200, 5, "per 2 hours"), (90, 2, "per 90 seconds")],
)
def test_rate_limit_periods(per_seconds: int, limit: int, said: str) -> None:
    """One of a unit drops the number; kakao_brand_message ships the hour and line_messaging_api the day."""
    store = MemoryStore()
    store.set(f"pg:rate:user:u1:{per_seconds}:{int(NOON.timestamp() // per_seconds)}", str(limit))
    d = evaluate([checks.RateLimit(limit=limit, per_seconds=per_seconds)], store=store, now=NOON)
    assert explain(d).summary == f"Held because the rate limit of {limit} messages {said} was already reached ({limit} used)."


def test_dedupe_delivered_and_missing_key() -> None:
    store = MemoryStore()
    store.set("pg:dedupe:u1:order:42", "1")
    seen = evaluate([checks.Dedupe()], c=candidate(dedupe_key="order:42"), store=store, now=NOON)
    assert explain(seen).summary == "Held because the same event already produced a message within the last day."
    no_key = evaluate([checks.Dedupe()], now=NOON)
    assert explain(no_key).checks[0].sentence == "The candidate carried no event key, so duplicate detection could not run."


def test_utility_floor() -> None:
    d = evaluate([checks.UtilityFloor(1, 1)], c=candidate(p_accept=0.3), now=NOON)
    assert explain(d).summary == "Held because the estimated chance the user would accept this message was 0.3, below the utility floor of 0.5."
    skip = evaluate([checks.UtilityFloor(1, 1)], now=NOON)
    assert explain(skip).checks[0].sentence == "The candidate carried no acceptance estimate, so the utility floor could not run."


def test_bounded_deferral_adjust() -> None:
    d = evaluate([checks.BoundedDeferral()], c=candidate(busy=True), now=NOON)
    assert d.allowed
    e = explain(d)
    assert e.checks[0].sentence.startswith("The user looked busy, so delivery was deferred 116")
    assert "delivery waits until" in e.summary


def test_allowed_window_custom_id() -> None:
    d = evaluate([checks.AllowedWindow("08:00", "21:00", timezone="user", id="window:tcpa")], now=NIGHT)
    assert d.rejected_by == "window:tcpa"
    assert explain(d).summary == "Held because messages may only go out between 08:00 and 21:00 (Europe/Istanbul), and the local time was outside that window."


def test_allowed_window_preset_id_names_the_window() -> None:
    """us_tcpa, kakao_brand_message and cn_minor_mode each give the window an id of its own."""
    named = evaluate([checks.AllowedWindow("08:00", "21:00", timezone="user", id="window:tcpa")], now=NOON)
    assert named.allowed is True
    assert explain(named).checks[0].sentence == 'The "tcpa" allowed window did not block it.'

    plain = evaluate([checks.AllowedWindow("08:00", "21:00", timezone="user")], now=NOON)
    assert explain(plain).checks[0].sentence == "The allowed window did not block it."

    no_zone = evaluate([checks.AllowedWindow("08:00", "21:00", timezone="user", id="window:tcpa")], u=user(timezone=None), now=NOON)
    assert explain(no_zone).checks[0].sentence == "The user has no time zone, so the allowed window could not be checked."


def test_requires_consent_with_and_without_hours() -> None:
    d = evaluate([checks.RequiresConsent("ad")], now=NOON)
    assert explain(d).summary == 'Held because the user has not given the required "ad" consent.'
    dn = evaluate([checks.RequiresConsent("night", when={"start": "21:00", "end": "08:00", "timezone": "user"})], now=NIGHT)
    assert explain(dn).summary == 'Held because the user has not given the required "night" consent, which applies between 21:00 and 08:00.'
    ok = evaluate([checks.RequiresConsent("ad")], u=user(consents={"ad": True}), now=NOON)
    assert explain(ok).checks[0].sentence == 'The "ad" consent the check needs was in place.'


def test_recent_interaction() -> None:
    never = evaluate([checks.RecentInteraction(48)], now=NOON)
    assert explain(never).summary == "Held because the user has never written to the assistant, and this rule allows messages only after they do."
    old = evaluate([checks.RecentInteraction(48)], u=user(last_inbound_at=datetime(2026, 9, 1, 8, 0, tzinfo=UTC)), now=NOON)
    assert explain(old).summary == "Held because the user's last message to the assistant was 73 h ago, outside the 48 h window."


def test_window_budget() -> None:
    store = MemoryStore()
    last = datetime(2026, 9, 4, 8, 0, tzinfo=UTC)
    store.set(f"pg:windowBudget:u1:{int(last.timestamp())}", "1")
    d = evaluate([checks.WindowBudget(limit=1, within_hours=48)], u=user(last_inbound_at=last), store=store, now=NOON)
    assert explain(d).summary == "Held because the budget for the window opened by the user's last message was already spent (1 of 1 used)."


def test_gate_entries_fail_open_closed_and_ignored_non_rejecting() -> None:
    class Boom(checks.BaseCheck):
        id = "mystery"

        def run(self, ctx: Any, values: Any) -> Any:
            raise RuntimeError("boom")

    opened = evaluate([Boom(), checks.Consent()], now=NOON)
    assert explain(opened).checks[0].sentence == 'The "mystery" check failed with "boom", and the gate is set to let messages through when a check fails.'
    closed = evaluate([Boom(), checks.Consent()], now=NOON, on_store_error="closed")
    assert explain(closed).summary == 'Held because the "mystery" check failed with "boom", and the gate is set to stop messages when a check fails.'

    class Polite(checks.BaseCheck):
        id = "polite"
        non_rejecting = True

        def run(self, ctx: Any, values: Any) -> Any:
            from proactive_gate.types import Outcome

            return Outcome("reject", "felt like it")

    ignored = evaluate([Polite(), checks.Consent()], now=NOON)
    assert explain(ignored).checks[0].sentence == 'The "polite" check tried to reject ("felt like it") but is marked non-rejecting, so the gate ignored it.'


def test_shadowed_stop_is_what_would_have_happened() -> None:
    class Shadowed(checks.BaseCheck):
        id = "quietHours"
        shadow = True

        def run(self, ctx: Any, values: Any) -> Any:
            from proactive_gate.types import Outcome

            return Outcome("reject", "quiet hours 22:00 to 08:00 Europe/Istanbul; priority normal is below the floor (critical)")

    d = evaluate([Shadowed(), checks.Consent()], now=NIGHT)
    e = explain(d)
    assert e.checks[0].shadow
    assert e.checks[0].sentence == (
        "It would have stopped the message (the user's quiet hours run 22:00 to 08:00 Europe/Istanbul "
        "and normal priority is below the critical floor needed to override them), but the check ran in shadow mode so evaluation continued."
    )
    assert "quietHours would have stopped it but ran in shadow mode" in e.summary


def test_shadowed_pass_does_not_claim_it_would_have_stopped() -> None:
    d = Decision(
        id="u1:c1:2026-09-04T09:00:00.000Z#1",
        allowed=True,
        user_id="u1",
        candidate_id="c1",
        surfaces=("feed",),
        trace=(TraceEntry(id="dailyBudget", outcome="pass", ms=0.0, reason="4 of 5 used", shadow=True),),
        evaluated_at=NOON,
    )
    assert explain(d).checks[0].sentence == (
        "The daily budget had room, but only just: 4 of 5 already used; "
        "the unit is spent when the message actually goes out."
    )


def test_unknown_check_quotes_its_own_reason() -> None:
    class Weekend(checks.BaseCheck):
        id = "weekend"

        def run(self, ctx: Any, values: Any) -> Any:
            from proactive_gate.types import Outcome

            return Outcome("reject", "weekend: only high priority")

    d = evaluate([Weekend()], now=NOON)
    assert explain(d).summary == 'Held because the "weekend" check stopped it: weekend: only high priority.'


def test_language_is_a_parameter() -> None:
    d = evaluate([checks.QuietHours()], now=NIGHT)
    assert explain(d).summary == explain(d, language="en").summary
    with pytest.raises(ValueError, match='no sentence catalog for language "tr"'):
        explain(d, language="tr")
    tr = {"summary.held": lambda f: f"{f['until']} kadar bekletildi, çünkü {f['clause']}"}
    e = explain(d, language="tr", catalogs={"tr": tr})
    assert e.summary.startswith("08:00 kadar bekletildi, çünkü")
    assert len(EN) > 0


def test_hand_built_decision_without_a_stopping_check() -> None:
    odd = Decision(
        id="u1:c1:2026-09-04T09:00:00.000Z#1",
        allowed=False,
        user_id="u1",
        candidate_id="c1",
        surfaces=(),
        trace=(),
        evaluated_at=NOON,
    )
    assert explain(odd).summary == "Held; the trace does not name the check that stopped it."


def test_every_trace_entry_renders() -> None:
    store = MemoryStore()
    gate = Gate(
        [
            *checks.default_checks(weekly_limit=20),
            checks.Dedupe(),
            checks.MonthlyBudget(),
            checks.UtilityFloor(1, 1),
            checks.BoundedDeferral(),
            checks.AllowedWindow("08:00", "21:00", timezone="user"),
            checks.RecentInteraction(48),
            checks.WindowBudget(limit=1, within_hours=48),
        ],
        store=store,
    )
    for now in (NOON, NIGHT, datetime(2026, 9, 6, 7, 0, tzinfo=UTC)):
        d = gate.evaluate(EvaluateInput(user(last_inbound_at=datetime(2026, 9, 4, 8, 0, tzinfo=UTC)), candidate(dedupe_key="evt:1", p_accept=0.7), now))
        e = explain(d)
        assert len(e.checks) == len(d.trace)
        for c in e.checks:
            assert len(c.sentence) > 10, f"empty sentence for {c.id}"
            assert c.sentence[0].isupper(), f"not a sentence for {c.id}: {c.sentence}"
