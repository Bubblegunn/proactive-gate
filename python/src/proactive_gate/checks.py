"""The checks, as sans-IO objects. A check names the store keys it needs
(``keys``) and decides purely from their values (``run``); budget-like checks
also describe their commit-time increment (``consume_plan``). Reasons match the
TypeScript package word for word so the shared fixtures hold for both."""
from __future__ import annotations

import json
import math
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime, timedelta
from typing import Protocol, runtime_checkable

from .clock import DAY_SECONDS, day_before, in_window, iso_week_key, local_clock, local_day, parse_hhmm, weekday_of
from .types import (
    PASS,
    ConsumePlan,
    Context,
    NearLimit,
    Outcome,
    Priority,
    QuietSchedule,
    QuietWindow,
    at_least,
    defer,
    epoch_ms,
    iso_z,
    reject,
    skip,
)

Values = Mapping[str, str | None]


@runtime_checkable
class Check(Protocol):
    id: str
    non_rejecting: bool
    shadow: bool

    def keys(self, ctx: Context) -> Sequence[str]: ...

    def run(self, ctx: Context, values: Values) -> Outcome: ...


class Consumer(Protocol):
    """A check that takes one unit at commit time."""

    def consume_plan(self, ctx: Context) -> ConsumePlan | None: ...


class BaseCheck:
    id: str = "check"
    non_rejecting: bool = False
    shadow: bool = False

    def keys(self, ctx: Context) -> Sequence[str]:
        return ()

    def run(self, ctx: Context, values: Values) -> Outcome:
        return PASS


def _num(n: float) -> str:
    """JavaScript number formatting for the reasons: 1 not 1.0, 0.556 not 0.5560."""
    if float(n).is_integer():
        return str(int(n))
    return repr(float(n))


def _round3(n: float) -> float:
    return math.floor(n * 1000 + 0.5) / 1000


def _js_round(n: float) -> int:
    return math.floor(n + 0.5)


class KillSwitch(BaseCheck):
    id = "killSwitch"

    def __init__(self, is_on: Callable[[], bool] | bool = False) -> None:
        self._is_on = is_on

    def run(self, ctx: Context, values: Values) -> Outcome:
        on = self._is_on() if callable(self._is_on) else self._is_on
        return reject("engine kill switch is on") if on else PASS


class Consent(BaseCheck):
    id = "consent"

    def run(self, ctx: Context, values: Values) -> Outcome:
        return PASS if ctx.user.consent else reject("user has not consented to proactive behaviour")


class Enabled(BaseCheck):
    id = "enabled"

    def run(self, ctx: Context, values: Values) -> Outcome:
        if ctx.user.proactive_enabled is False:
            return reject("proactive behaviour is disabled on this profile")
        return PASS


class Mode(BaseCheck):
    id = "mode"

    def __init__(self, allow: Sequence[str] = ("normal",)) -> None:
        self.allow = tuple(allow)

    def run(self, ctx: Context, values: Values) -> Outcome:
        mode = ctx.user.mode
        if mode is not None and mode not in self.allow:
            return reject(f'operating mode "{mode}" does not allow proactive messages')
        return PASS


class Snooze(BaseCheck):
    id = "snooze"

    def __init__(self, defer: bool = False) -> None:
        self.defer = defer

    def run(self, ctx: Context, values: Values) -> Outcome:
        until = ctx.user.snoozed_until
        if until is None or until <= ctx.now:
            return PASS
        reason = f"snoozed until {iso_z(until)}"
        return defer(reason, until) if self.defer else reject(reason)


class Mute(BaseCheck):
    id = "mute"

    def run(self, ctx: Context, values: Values) -> Outcome:
        if ctx.candidate.type in ctx.user.muted_types:
            return reject(f'type "{ctx.candidate.type}" is muted by the user')
        return PASS


class Intensity(BaseCheck):
    id = "intensity"

    def __init__(self, floors: Mapping[str, str] | None = None) -> None:
        self.floors: Mapping[str, str] = floors or {"low": "high", "normal": "normal", "high": "low"}

    def run(self, ctx: Context, values: Values) -> Outcome:
        level = ctx.user.intensity or "normal"
        floor = self.floors[level]
        if at_least(ctx.priority, floor):
            return PASS
        return reject(f'priority {ctx.priority} is below the "{level}" intensity floor ({floor})')


def window_for(quiet: QuietWindow | QuietSchedule, day: str) -> QuietWindow | None:
    """The window in force on one local date: a date beats a weekday beats the default."""
    if isinstance(quiet, QuietWindow):
        return quiet
    if day in quiet.dates:
        return quiet.dates[day]
    weekday = weekday_of(day)
    if weekday in quiet.days:
        return quiet.days[weekday]
    return quiet.default


def quiet_at(quiet: QuietWindow | QuietSchedule, day: str, minutes: int) -> tuple[QuietWindow, str] | None:
    """The window silencing ``minutes`` on ``day``, and the day it opened on.

    A window that crosses midnight belongs to the day it opens on, so a time can be
    quiet because of yesterday. With one window every day this reduces exactly to
    ``in_window``, which is why the single-window form behaves as it did.
    """
    today = window_for(quiet, day)
    if today is not None:
        start, end = parse_hhmm(today.start), parse_hhmm(today.end)
        if start != end and (start <= minutes < end if start < end else minutes >= start):
            return today, day
    previous = day_before(day)
    yesterday = window_for(quiet, previous)
    if yesterday is not None:
        start, end = parse_hhmm(yesterday.start), parse_hhmm(yesterday.end)
        if start > end and minutes < end:
            return yesterday, previous
    return None


class QuietHours(BaseCheck):
    id = "quietHours"

    def __init__(self, priority_floor: str = "critical") -> None:
        self.floor = priority_floor

    def run(self, ctx: Context, values: Values) -> Outcome:
        qh = ctx.user.quiet_hours
        if qh is None:
            return PASS
        if not ctx.user.timezone:
            return skip("quiet hours set but no timezone on the user; cannot evaluate")
        minutes, day = local_clock(ctx.now, ctx.user.timezone)
        hit = quiet_at(qh, day, minutes)
        if hit is None:
            return PASS
        if at_least(ctx.priority, self.floor):
            return PASS
        window, from_day = hit
        # Name the day the window opened on when it was not today: the reason is
        # yesterday's setting, and a reader checking today's would not find it.
        whose = "" if from_day == day else f" ({weekday_of(from_day)} {from_day})"
        return reject(f"quiet hours {window.start} to {window.end}{whose} {ctx.user.timezone}; priority {ctx.priority} is below the floor ({self.floor})")


class TrustRamp(BaseCheck):
    id = "trustRamp"

    def __init__(self, days: float = 7, min_priority: str = "high") -> None:
        self.days = days
        self.floor = min_priority

    def run(self, ctx: Context, values: Values) -> Outcome:
        created = ctx.user.created_at
        if created is None:
            return skip("no createdAt on the user; ramp cannot be evaluated")
        age = (ctx.now - created).total_seconds() / DAY_SECONDS
        if age >= self.days:
            return PASS
        if at_least(ctx.priority, self.floor):
            return PASS
        return reject(f"trust ramp: day {math.floor(age) + 1} of {_num(self.days)}, priority {ctx.priority} is below {self.floor}")


def dismissal_key(user_id: str, type_: str) -> str:
    return f"cooldown:{user_id}:{type_}"


class DismissalCooldown(BaseCheck):
    id = "dismissalCooldown"

    def __init__(self, dismissals: int = 3, within_days: float = 30, silence_days: float = 7) -> None:
        self.n = dismissals
        self.within_days = within_days
        self.silence_days = silence_days

    def keys(self, ctx: Context) -> Sequence[str]:
        return (dismissal_key(ctx.user.id, ctx.candidate.type),)

    def run(self, ctx: Context, values: Values) -> Outcome:
        raw = values.get(dismissal_key(ctx.user.id, ctx.candidate.type))
        stamps: list[int] = json.loads(raw) if raw else []
        window_start = epoch_ms(ctx.now) - self.within_days * DAY_SECONDS * 1000
        recent = sorted(t for t in stamps if t >= window_start)
        if len(recent) < self.n:
            return PASS
        silent_until = recent[-1] + self.silence_days * DAY_SECONDS * 1000
        if epoch_ms(ctx.now) >= silent_until:
            return PASS
        until = datetime.fromtimestamp(silent_until / 1000, tz=ctx.now.tzinfo)
        return reject(f'{len(recent)} dismissals of "{ctx.candidate.type}" in {_num(self.within_days)} days; silent until {iso_z(until)}')


class AdaptiveTiming(BaseCheck):
    """Never rejects. Plug in ``next_good_moment`` and ``surfaces_for`` from your own model."""

    id = "adaptiveTiming"
    non_rejecting = True

    def __init__(
        self,
        next_good_moment: Callable[[Context], datetime | None] | None = None,
        surfaces_for: Callable[[Context], Sequence[str] | None] | None = None,
    ) -> None:
        self.next_good_moment = next_good_moment
        self.surfaces_for = surfaces_for

    def run(self, ctx: Context, values: Values) -> Outcome:
        at = self.next_good_moment(ctx) if self.next_good_moment else None
        surfaces = self.surfaces_for(ctx) if self.surfaces_for else None
        if at is None and surfaces is None:
            return PASS
        parts: list[str] = []
        if at is not None:
            parts.append(f"deliver at {iso_z(at)}")
        if surfaces is not None:
            parts.append(f"surfaces {','.join(surfaces)}")
        return Outcome("adjust", "; ".join(parts), deliver_at=at, surfaces=tuple(surfaces) if surfaces is not None else None)


class Budget(BaseCheck):
    """Reads a counter at evaluate, increments it at commit. Subclasses name the key."""

    label = "budget"
    default_limit = 5
    ttl_seconds = 2 * DAY_SECONDS

    def __init__(self, limit: int | None = None, bypass_priority: str | None = None, near_limit: float = 0.8) -> None:
        self.limit = limit if limit is not None else self.default_limit
        self.bypass_priority = bypass_priority
        self.near_at = max(1, math.ceil(self.limit * near_limit))

    def key_for(self, ctx: Context) -> str:
        raise NotImplementedError

    def bypass(self, ctx: Context) -> bool:
        return self.bypass_priority is not None and at_least(ctx.priority, self.bypass_priority)

    def keys(self, ctx: Context) -> Sequence[str]:
        return () if self.bypass(ctx) else (self.key_for(ctx),)

    def run(self, ctx: Context, values: Values) -> Outcome:
        if self.bypass(ctx):
            return PASS
        used = int(values.get(self.key_for(ctx)) or 0)
        if used >= self.limit:
            return reject(f"{self.label} of {self.limit} used ({used})")
        if used >= self.near_at:
            return Outcome("pass", f"{used} of {self.limit} used", near_limit=NearLimit(used, self.limit))
        return PASS

    def consume_plan(self, ctx: Context) -> ConsumePlan | None:
        if self.bypass(ctx):
            return None
        return ConsumePlan(self.key_for(ctx), self.ttl_seconds, self.limit)


def budget_key(user_id: str, now: datetime, tz: str | None = None) -> str:
    return f"budget:{user_id}:{local_day(now, tz)}"


def weekly_budget_key(user_id: str, now: datetime, tz: str | None = None) -> str:
    return f"weeklyBudget:{user_id}:{iso_week_key(local_day(now, tz))}"


def monthly_budget_key(user_id: str, now: datetime, tz: str | None = None) -> str:
    return f"monthlyBudget:{user_id}:{local_day(now, tz)[:7]}"


class DailyBudget(Budget):
    id = "dailyBudget"
    label = "daily budget"
    default_limit = 5
    ttl_seconds = 2 * DAY_SECONDS

    def key_for(self, ctx: Context) -> str:
        return budget_key(ctx.user.id, ctx.now, ctx.user.timezone)


class WeeklyBudget(Budget):
    id = "weeklyBudget"
    label = "weekly budget"
    default_limit = 20
    ttl_seconds = 8 * DAY_SECONDS

    def key_for(self, ctx: Context) -> str:
        return weekly_budget_key(ctx.user.id, ctx.now, ctx.user.timezone)


class MonthlyBudget(Budget):
    id = "monthlyBudget"
    label = "monthly budget"
    default_limit = 60
    ttl_seconds = 32 * DAY_SECONDS

    def key_for(self, ctx: Context) -> str:
        return monthly_budget_key(ctx.user.id, ctx.now, ctx.user.timezone)


class UtilityFloor(BaseCheck):
    """Act only when the caller's pAccept clears tau = cFA / (cFA + pNeed * cFN)."""

    id = "utilityFloor"

    def __init__(self, cost_false_alarm: float = 1, cost_missed_help: float = 1) -> None:
        self.c_fa = cost_false_alarm
        self.c_fn = cost_missed_help

    def run(self, ctx: Context, values: Values) -> Outcome:
        p_accept = ctx.candidate.p_accept
        if p_accept is None:
            return skip("no pAccept on the candidate; utility floor cannot be evaluated")
        p_need = ctx.candidate.p_need if ctx.candidate.p_need is not None else 1
        tau = self.c_fa / (self.c_fa + p_need * self.c_fn)
        if p_accept >= tau:
            return PASS
        return reject(f"pAccept {_num(_round3(p_accept))} < tau {_num(_round3(tau))}")


class BoundedDeferral(BaseCheck):
    """Horvitz bounded deferral: wait t* = min(bound, lambda * c / (2 * staleness)) while the user is busy."""

    id = "boundedDeferral"
    non_rejecting = True

    def __init__(
        self,
        lambda_: float = 1 / 43,
        interrupt_cost: float = 1,
        staleness: float = 0.0001,
        bound_seconds: float = 240,
        is_busy: Callable[[Context], bool] | None = None,
    ) -> None:
        self.t_star = min(bound_seconds, (lambda_ * interrupt_cost) / (2 * staleness))
        self.is_busy = is_busy

    def run(self, ctx: Context, values: Values) -> Outcome:
        busy = self.is_busy(ctx) if self.is_busy else ctx.candidate.busy is True
        if not busy:
            return PASS
        at = ctx.now + timedelta(milliseconds=_js_round(self.t_star * 1000))
        return Outcome("adjust", f"user busy; deliver at {iso_z(at)} (t* {_js_round(self.t_star)} s)", deliver_at=at)


def _zone_of(ctx: Context, tz: str) -> str | None:
    return ctx.user.timezone if tz == "user" else tz


class AllowedWindow(BaseCheck):
    def __init__(self, start: str, end: str, timezone: str = "user", priority_floor: str | None = None, id: str = "allowedWindow") -> None:
        self.id = id
        self.start_text, self.end_text = start, end
        self.start, self.end = parse_hhmm(start), parse_hhmm(end)
        self.timezone = timezone
        self.priority_floor = priority_floor

    def run(self, ctx: Context, values: Values) -> Outcome:
        zone = _zone_of(ctx, self.timezone)
        if not zone:
            return skip("no timezone on the user; window cannot be evaluated")
        if self.priority_floor and at_least(ctx.priority, self.priority_floor):
            return PASS
        minutes, _ = local_clock(ctx.now, zone)
        if in_window(minutes, self.start, self.end):
            return PASS
        return reject(f"outside the allowed window {self.start_text} to {self.end_text} {zone}")


class RequiresConsent(BaseCheck):
    def __init__(self, name: str, when: Mapping[str, str] | None = None, id: str | None = None) -> None:
        self.name = name
        self.id = id or f"consent:{name}"
        self.when = when

    def run(self, ctx: Context, values: Values) -> Outcome:
        suffix = ""
        if self.when:
            zone = _zone_of(ctx, self.when["timezone"])
            if not zone:
                return skip("no timezone on the user; consent window cannot be evaluated")
            minutes, _ = local_clock(ctx.now, zone)
            if not in_window(minutes, parse_hhmm(self.when["start"]), parse_hhmm(self.when["end"])):
                return PASS
            suffix = f" (required {self.when['start']} to {self.when['end']})"
        if ctx.user.consents.get(self.name):
            return PASS
        return reject(f'consent "{self.name}" is missing{suffix}')


class RateLimit(Budget):
    """Fixed-window rate limit keyed by user or by candidate.channel; consumed at commit."""

    def __init__(self, limit: int, per_seconds: int, key_by: str = "user", id: str | None = None) -> None:
        super().__init__(limit=limit, near_limit=1)
        self.per_seconds = per_seconds
        self.key_by = key_by
        self.id = id or f"rate:{limit}/{per_seconds}s"
        self.label = f"rate limit {limit} per {per_seconds} s"
        self.ttl_seconds = per_seconds * 2

    def key_for(self, ctx: Context) -> str:
        scope = (ctx.candidate.channel or ctx.user.id) if self.key_by == "channel" else ctx.user.id
        window = math.floor(epoch_ms(ctx.now) / 1000 / self.per_seconds)
        return f"rate:{self.key_by}:{scope}:{self.per_seconds}:{window}"


class RecentInteraction(BaseCheck):
    id = "recentInteraction"

    def __init__(self, within_hours: float = 48) -> None:
        self.within_hours = within_hours

    def run(self, ctx: Context, values: Values) -> Outcome:
        last = ctx.user.last_inbound_at
        if last is None:
            return reject("no inbound message from the user on record")
        age = (ctx.now - last).total_seconds() / 3600
        if age <= self.within_hours:
            return PASS
        return reject(f"last inbound message {math.floor(age)} h ago, window is {_num(self.within_hours)} h")


class WindowBudget(Budget):
    id = "windowBudget"
    label = "window budget"

    def __init__(self, limit: int, within_hours: float) -> None:
        super().__init__(limit=limit, near_limit=1)
        self.ttl_seconds = int(within_hours * 3600)

    def key_for(self, ctx: Context) -> str:
        last = ctx.user.last_inbound_at
        opened = math.floor(epoch_ms(last) / 1000) if last else "none"
        return f"windowBudget:{ctx.user.id}:{opened}"


class OnlyWhen(BaseCheck):
    """Runs the wrapped check only when ``predicate`` holds; otherwise passes with ``reason``."""

    def __init__(self, inner: Check, predicate: Callable[[Context], bool], reason: str) -> None:
        self.inner = inner
        self.id = inner.id
        self.non_rejecting = inner.non_rejecting
        self.predicate = predicate
        self.reason = reason

    def keys(self, ctx: Context) -> Sequence[str]:
        return self.inner.keys(ctx) if self.predicate(ctx) else ()

    def run(self, ctx: Context, values: Values) -> Outcome:
        return self.inner.run(ctx, values) if self.predicate(ctx) else Outcome("pass", self.reason)

    def consume_plan(self, ctx: Context) -> ConsumePlan | None:
        if not self.predicate(ctx):
            return None
        inner = self.inner
        if isinstance(inner, Budget):
            return inner.consume_plan(ctx)
        return None


def default_checks(
    kill_switch: Callable[[], bool] | bool = False,
    modes: Sequence[str] = ("normal",),
    daily_limit: int = 5,
    weekly_limit: int | None = None,
    quiet_hours_floor: str = "critical",
) -> list[Check]:
    """The LILA order, as a starting point."""
    checks: list[Check] = [
        KillSwitch(kill_switch),
        Consent(),
        Enabled(),
        Mode(modes),
        Snooze(),
        Mute(),
        Intensity(),
        QuietHours(quiet_hours_floor),
        TrustRamp(),
        DismissalCooldown(),
        AdaptiveTiming(),
    ]
    if weekly_limit is not None:
        checks.append(WeeklyBudget(limit=weekly_limit))
    checks.append(DailyBudget(limit=daily_limit))
    return checks


__all__ = [
    "AdaptiveTiming", "AllowedWindow", "BaseCheck", "BoundedDeferral", "Budget", "Check", "Consent", "Consumer",
    "DailyBudget", "DismissalCooldown", "Enabled", "Intensity", "KillSwitch", "Mode", "MonthlyBudget", "Mute",
    "OnlyWhen", "QuietHours", "RateLimit", "RecentInteraction", "RequiresConsent", "Snooze", "TrustRamp",
    "UtilityFloor", "WeeklyBudget", "WindowBudget", "budget_key", "default_checks", "dismissal_key",
    "monthly_budget_key", "weekly_budget_key",
]
