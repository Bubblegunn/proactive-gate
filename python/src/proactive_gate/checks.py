"""The checks, as sans-IO objects. A check names the store keys it needs
(``keys``) and decides purely from their values (``run``); budget-like checks
also describe their commit-time increment (``consume_plan``). Reasons match the
TypeScript package word for word so the shared fixtures hold for both."""
from __future__ import annotations

import json
import math
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol, runtime_checkable
from zoneinfo import ZoneInfo

from .clock import DAY_SECONDS, day_before, in_window, iso_week_key, local_clock, local_day, next_key_change, parse_hhmm, weekday_of
from .types import (
    PASS,
    Candidate,
    ConsumePlan,
    Context,
    NearLimit,
    Outcome,
    Priority,
    QuietSchedule,
    QuietWindow,
    UserState,
    is_count,
    to_datetime,
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


def _evidence_count(value: object) -> float:
    """A count the caller supplied as evidence: a finite JSON number, else zero (SPEC 9.9). A string is not a number."""
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return float(value)
    return 0.0


def _count(value: object) -> float:
    """A count as a number, read the way the TypeScript package reads it: absent is zero, text is parsed,
    and anything that is not a number is NaN, which makes a total not finite (SPEC 9.11)."""
    if value is None:
        return 0.0
    if isinstance(value, (bool, int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        if text == "":
            return 0.0
        try:
            return float(text)
        except ValueError:
            return math.nan
    return math.nan


def is_valid_zone(zone: object) -> bool:
    """True when ``zone`` is an IANA name the runtime knows."""
    if not isinstance(zone, str) or not zone:
        return False
    try:
        ZoneInfo(zone)
    except Exception:  # noqa: BLE001 - any failure to load the zone means it is not one
        return False
    return True


def effective_zone(user: UserState) -> str | None:
    """``deviceTimezone`` when valid, else ``timezone`` when valid, else none (SPEC 9.2)."""
    if is_valid_zone(user.device_timezone):
        return user.device_timezone
    if is_valid_zone(user.timezone):
        return user.timezone
    return None


def reported_zone(user: UserState) -> str | None:
    """The zone quiet hours need under ``onMissingTimezone`` "reject": the placeholder "UTC" is no zone unless a valid device zone exists (SPEC 9.2.1)."""
    if is_valid_zone(user.device_timezone):
        return user.device_timezone
    if is_valid_zone(user.timezone) and user.timezone != "UTC":
        return user.timezone
    return None


def hour_of_day(now: datetime, zone: str | None) -> int:
    """The local hour, 0 to 23, in ``zone``, or the UTC hour when there is no zone (SPEC 9.11)."""
    if zone:
        return local_clock(now, zone)[0] // 60
    return now.astimezone(UTC).hour


def is_commitment(candidate: Candidate) -> bool:
    """Something the person set up, such as a reminder they asked for (SPEC 9.4)."""
    return candidate.kind == "commitment"


def not_promotional(candidate: Candidate) -> str | None:
    """Why a candidate is not promotional (SPEC 9.7), or None when it may be promotion."""
    if candidate.transactional is True:
        return "transactional"
    if candidate.requested is True:
        return "requested"
    if is_commitment(candidate):
        return "commitment"
    return None


def hours_key(user_id: str, hour: int, outcome: str) -> str:
    """The store key of one local hour's acted or dismissed count (SPEC 9.11)."""
    return f"hours:{user_id}:{hour}:{outcome}"


class KillSwitch(BaseCheck):
    id = "killSwitch"

    def __init__(self, is_on: Callable[[], bool] | bool = False) -> None:
        self._is_on = is_on

    def run(self, ctx: Context, values: Values) -> Outcome:
        on = self._is_on() if callable(self._is_on) else self._is_on
        return reject("engine kill switch is on") if on else PASS


class Consent(BaseCheck):
    """Consent, and what a failed consent lookup keeps open (SPEC 9.3).

    ``fail_mode`` maps a surface to "open" or "closed", with an optional ``default``. Read only when
    ``consentUnknown`` is true; a known consent is decided by ``consent`` alone.
    """

    id = "consent"

    def __init__(self, fail_mode: Mapping[str, str] | None = None) -> None:
        self.fail_mode: Mapping[str, str] = fail_mode or {}

    def _mode_for(self, surface: str) -> str:
        if surface in self.fail_mode:
            return self.fail_mode[surface]
        return self.fail_mode.get("default", "closed")

    def run(self, ctx: Context, values: Values) -> Outcome:
        if ctx.user.consent_unknown is not True:
            return PASS if ctx.user.consent else reject("user has not consented to proactive behaviour")
        open_surfaces = tuple(s for s in ctx.surfaces if self._mode_for(s) == "open")
        if not open_surfaces:
            return reject("consent could not be determined and no surface on the table fails open")
        return Outcome("adjust", f"consent could not be determined; keeping {', '.join(open_surfaces)}", surfaces=open_surfaces)


class KillSwitchFlag(BaseCheck):
    """Rejects while the runtime flag ``name`` is exactly false (SPEC 9.13). An absent flag stops nothing."""

    id = "killSwitch"

    def __init__(self, name: str) -> None:
        self.name = name

    def run(self, ctx: Context, values: Values) -> Outcome:
        flags = ctx.flags or {}
        if flags.get(self.name) is False:
            return reject(f'kill switch is on: flag "{self.name}" is false')
        return PASS


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

    def next_allowed_at(self, ctx: Context) -> datetime | None:
        return ctx.user.snoozed_until


class Mute(BaseCheck):
    id = "mute"

    def run(self, ctx: Context, values: Values) -> Outcome:
        if is_commitment(ctx.candidate):
            return PASS
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


_MINUTE = timedelta(minutes=1)


def quiet_ends_at(quiet: QuietWindow | QuietSchedule, tz: str, now: datetime) -> datetime | None:
    """The earliest minute after ``now`` at which quiet hours stop applying, or ``None``.

    Each jump moves to the end of the window silencing the current local time. A daylight-saving
    change between the two instants lands the jump an hour early (still quiet, so it jumps again)
    or an hour late (so it steps back a minute at a time to the first open minute). Same
    algorithm as ``quietEndsAt`` in the TypeScript package, held to the same fixtures.
    """
    start = now.astimezone(UTC).replace(second=0, microsecond=0)
    at = start
    for _ in range(16):
        minutes, day = local_clock(at, tz)
        hit = quiet_at(quiet, day, minutes)
        if hit is None:
            for _back in range(180):
                earlier = at - _MINUTE
                if earlier <= start:
                    break
                before_minutes, before_day = local_clock(earlier, tz)
                if quiet_at(quiet, before_day, before_minutes) is not None:
                    break
                at = earlier
            return at if at > now else None
        until_end = (parse_hhmm(hit[0].end) - minutes) % 1440 or 1
        at = at + timedelta(minutes=until_end)
    return None


class QuietHours(BaseCheck):
    """Quiet hours in the user's effective zone (SPEC 9.2). ``on_missing_timezone`` is "skip" (the default) or "reject"."""

    id = "quietHours"

    def __init__(self, priority_floor: str = "critical", on_missing_timezone: str = "skip") -> None:
        self.floor = priority_floor
        self.reject_without_zone = on_missing_timezone == "reject"

    def _zone(self, ctx: Context) -> str | None:
        return reported_zone(ctx.user) if self.reject_without_zone else effective_zone(ctx.user)

    def run(self, ctx: Context, values: Values) -> Outcome:
        zone = self._zone(ctx)
        if zone is None and self.reject_without_zone:
            return reject("no time zone on the user; quiet hours cannot be evaluated")
        qh = ctx.user.quiet_hours
        if qh is None:
            return PASS
        if zone is None:
            return skip("quiet hours set but no timezone on the user; cannot evaluate")
        minutes, day = local_clock(ctx.now, zone)
        hit = quiet_at(qh, day, minutes)
        if hit is None:
            return PASS
        if at_least(ctx.priority, self.floor):
            return PASS
        window, from_day = hit
        # Name the day the window opened on when it was not today: the reason is
        # yesterday's setting, and a reader checking today's would not find it.
        whose = "" if from_day == day else f" ({weekday_of(from_day)} {from_day})"
        return reject(f"quiet hours {window.start} to {window.end}{whose} {zone}; priority {ctx.priority} is below the floor ({self.floor})")

    def next_allowed_at(self, ctx: Context) -> datetime | None:
        qh = ctx.user.quiet_hours
        zone = self._zone(ctx)
        if qh is None or zone is None:
            return None
        return quiet_ends_at(qh, zone, ctx.now)


class TrustRamp(BaseCheck):
    id = "trustRamp"

    def __init__(self, days: float = 7, min_priority: str = "high") -> None:
        self.days = days
        self.floor = min_priority

    def run(self, ctx: Context, values: Values) -> Outcome:
        # A requested candidate and a commitment are the person's own doing (SPEC 9.4, 9.5).
        if ctx.candidate.requested is True:
            return Outcome("pass", "requested by the person; the trust ramp does not apply")
        if is_commitment(ctx.candidate):
            return Outcome("pass", "a commitment the person set up; the trust ramp does not apply")
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

    def __init__(self, dismissals: int = 3, within_days: float = 30, silence_days: float = 7, exempt_types: Sequence[str] | None = None) -> None:
        self.n = dismissals
        self.within_days = within_days
        self.silence_days = silence_days
        self.exempt_types = tuple(exempt_types or ())

    def keys(self, ctx: Context) -> Sequence[str]:
        return (dismissal_key(ctx.user.id, ctx.candidate.type),)

    def run(self, ctx: Context, values: Values) -> Outcome:
        # A commitment and a listed type are never silenced by the cooldown (SPEC 9.4, 9.6).
        if is_commitment(ctx.candidate):
            return Outcome("pass", "a commitment the person set up; the dismissal cooldown does not apply")
        if ctx.candidate.type in self.exempt_types:
            return Outcome("pass", f'type "{ctx.candidate.type}" is exempt from the dismissal cooldown')
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
    """Reads a counter at evaluate, increments it at commit. Subclasses name the key.

    A commitment (SPEC 9.4) and a bypassed priority are not counted. The limit is the check's own,
    unless the user has a ``dailyLimit`` override or a tier named in ``tiers`` (SPEC 9.12).
    """

    label = "budget"
    default_limit = 5
    ttl_seconds = 2 * DAY_SECONDS

    def __init__(self, limit: int | None = None, bypass_priority: str | None = None, near_limit: float = 0.8, tiers: Mapping[str, Any] | None = None) -> None:
        self.limit = limit if limit is not None else self.default_limit
        self.bypass_priority = bypass_priority
        self.near_fraction = near_limit
        self.tiers: Mapping[str, Any] = tiers or {}

    def key_for(self, ctx: Context) -> str:
        raise NotImplementedError

    def key_at(self, user_id: str, at: datetime, tz: str | None) -> str:
        """The counter key in force at ``at``; the reset is the first minute this answers differently."""
        raise NotImplementedError

    def override(self, user: UserState) -> float | None:
        """An explicit per-user limit that wins over the tiers, or None."""
        return None

    def effective_limit(self, ctx: Context) -> float:
        override = self.override(ctx.user)
        if override is not None:
            return override
        tier = ctx.user.tier
        if tier is not None and tier in self.tiers and is_count(self.tiers[tier]):
            return float(self.tiers[tier])
        return self.limit

    def bypass(self, ctx: Context) -> bool:
        return self.bypass_priority is not None and at_least(ctx.priority, self.bypass_priority)

    def skipped(self, ctx: Context) -> bool:
        return is_commitment(ctx.candidate) or self.bypass(ctx)

    def keys(self, ctx: Context) -> Sequence[str]:
        return () if self.skipped(ctx) else (self.key_for(ctx),)

    def run(self, ctx: Context, values: Values) -> Outcome:
        if is_commitment(ctx.candidate):
            return Outcome("pass", "a commitment the person set up; it spends no budget")
        if self.bypass(ctx):
            return PASS
        limit = self.effective_limit(ctx)
        used = int(values.get(self.key_for(ctx)) or 0)
        if used >= limit:
            return reject(f"{self.label} of {_num(limit)} used ({used})")
        near_at = max(1, math.ceil(limit * self.near_fraction))
        if used >= near_at:
            return Outcome("pass", f"{used} of {_num(limit)} used", near_limit=NearLimit(used, int(limit)))
        return PASS

    def consume_plan(self, ctx: Context) -> ConsumePlan | None:
        if self.skipped(ctx):
            return None
        return ConsumePlan(self.key_for(ctx), self.ttl_seconds, int(self.effective_limit(ctx)))

    def next_allowed_at(self, ctx: Context) -> datetime | None:
        user = ctx.user
        zone = effective_zone(user)
        try:
            return next_key_change(ctx.now, zone, lambda at: self.key_at(user.id, at, zone))
        except NotImplementedError:
            return None


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

    def override(self, user: UserState) -> float | None:
        explicit: Any = user.daily_limit
        if is_count(explicit) and math.isfinite(explicit) and explicit >= 0:
            return float(explicit)
        return None

    def key_for(self, ctx: Context) -> str:
        return budget_key(ctx.user.id, ctx.now, effective_zone(ctx.user))

    def key_at(self, user_id: str, at: datetime, tz: str | None) -> str:
        return budget_key(user_id, at, tz)


class WeeklyBudget(Budget):
    id = "weeklyBudget"
    label = "weekly budget"
    default_limit = 20
    ttl_seconds = 8 * DAY_SECONDS

    def key_for(self, ctx: Context) -> str:
        return weekly_budget_key(ctx.user.id, ctx.now, effective_zone(ctx.user))

    def key_at(self, user_id: str, at: datetime, tz: str | None) -> str:
        return weekly_budget_key(user_id, at, tz)


class MonthlyBudget(Budget):
    id = "monthlyBudget"
    label = "monthly budget"
    default_limit = 60
    ttl_seconds = 32 * DAY_SECONDS

    def key_for(self, ctx: Context) -> str:
        return monthly_budget_key(ctx.user.id, ctx.now, effective_zone(ctx.user))

    def key_at(self, user_id: str, at: datetime, tz: str | None) -> str:
        return monthly_budget_key(user_id, at, tz)


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
    return effective_zone(ctx.user) if tz == "user" else tz


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
    """Requires ``consents[name]``, always or only inside a window. ``exempt_transactional`` lifts it for
    candidates that are not promotional (SPEC 9.7)."""

    def __init__(self, name: str, when: Mapping[str, str] | None = None, id: str | None = None, exempt_transactional: bool = False) -> None:
        self.name = name
        self.id = id or f"consent:{name}"
        self.when = when
        self.exempt_transactional = exempt_transactional

    def run(self, ctx: Context, values: Values) -> Outcome:
        if self.exempt_transactional:
            why = not_promotional(ctx.candidate)
            if why:
                return Outcome("pass", f'{why}; not promotional, so consent "{self.name}" is not required')
        suffix = ""
        if self.when:
            zone = _zone_of(ctx, self.when["timezone"])
            if not zone:
                return skip("no timezone on the user; consent window cannot be evaluated")
            minutes, _ = local_clock(ctx.now, zone)
            if not in_window(minutes, parse_hhmm(self.when["start"]), parse_hhmm(self.when["end"])):
                # A bare pass here would be indistinguishable from "the consent is on
                # file", and explain() said exactly that about a consent nobody gave.
                return Outcome("pass", f"outside the consent window {self.when['start']} to {self.when['end']}")
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


class CrisisQuiet(BaseCheck):
    """Rejects every candidate while ``user.crisisUntil`` is after now, except ``kind: "support"`` (SPEC 9.10)."""

    id = "crisisQuiet"

    def run(self, ctx: Context, values: Values) -> Outcome:
        until = ctx.user.crisis_until
        if until is None or until <= ctx.now or ctx.candidate.kind == "support":
            return PASS
        return reject(f"crisis quiet period until {iso_z(until)}; only support messages pass")

    def next_allowed_at(self, ctx: Context) -> datetime | None:
        return ctx.user.crisis_until


class Freshness(BaseCheck):
    """Refuses stale content (SPEC 9.8). ``max_age_seconds`` also refuses content created too long ago."""

    id = "freshness"

    def __init__(self, max_age_seconds: float | None = None) -> None:
        self.max_age = max_age_seconds

    def run(self, ctx: Context, values: Values) -> Outcome:
        candidate = ctx.candidate
        has_until = candidate.fresh_until is not None
        has_created = candidate.created_at is not None
        if not has_until and not (has_created and self.max_age is not None):
            if has_created:
                return skip("no maxAgeSeconds set; createdAt is not checked")
            return skip("no freshUntil or createdAt on the candidate; freshness cannot be evaluated")
        if has_until:
            until = to_datetime(candidate.fresh_until)
            if until is None:
                return reject("freshUntil is not a valid instant; treated as expired")
            if until <= ctx.now:
                return reject(f"expired at {iso_z(until)}")
        if has_created and self.max_age is not None:
            created = to_datetime(candidate.created_at)
            if created is None:
                return reject("createdAt is not a valid instant; treated as expired")
            if (ctx.now - created).total_seconds() > self.max_age:
                return reject(f"expired: created {iso_z(created)}, older than {_num(self.max_age)} seconds")
        return PASS


class Silence(BaseCheck):
    """Refuses a candidate whose caller-supplied evidence is too thin (SPEC 9.9). The gate never fills evidence."""

    id = "silence"

    def __init__(self, min_data_points: float = 5, min_confidence: float = 0.5, require_new: bool = True) -> None:
        self.min_points = min_data_points
        self.min_confidence = min_confidence
        self.require_new = require_new

    def run(self, ctx: Context, values: Values) -> Outcome:
        evidence = ctx.candidate.evidence
        if evidence is None:
            return skip("no evidence on the candidate; silence cannot be evaluated")
        data: Mapping[str, Any] = evidence if isinstance(evidence, Mapping) else {}
        points = _evidence_count(data.get("dataPoints"))
        if points < self.min_points:
            return reject(f"not enough data: {_num(points)} data points, need {_num(self.min_points)}")
        confidence = _evidence_count(data.get("confidence"))
        if confidence < self.min_confidence:
            return reject(f"not enough confidence: {_num(confidence)}, need {_num(self.min_confidence)}")
        if self.require_new and data.get("newSinceLast") is False:
            return reject("nothing new since the last message")
        return PASS


class DeadHours(BaseCheck):
    """Takes push off the table in an hour when the user acted on too little of what they got then (SPEC 9.11).

    Never rejects. The counts are the caller's ``hourStats`` entry for the hour when given, else the
    counters ``Gate.record`` wrote. The defaults are judgements, not findings.
    """

    id = "deadHours"
    non_rejecting = True

    def __init__(self, min_samples: float = 5, max_act_rate: float = 0.2, min_priority: str = "high") -> None:
        self.min_samples = min_samples
        self.max_act_rate = max_act_rate
        self.floor = min_priority

    def _judged(self, ctx: Context) -> bool:
        return "push" in ctx.surfaces and not at_least(ctx.priority, self.floor)

    def _own_entry(self, ctx: Context, hour: int) -> tuple[bool, Any]:
        stats = ctx.user.hour_stats
        if not isinstance(stats, Mapping):
            return False, None
        entry = stats.get(str(hour))
        return entry is not None, entry

    def keys(self, ctx: Context) -> Sequence[str]:
        if not self._judged(ctx):
            return ()
        hour = hour_of_day(ctx.now, effective_zone(ctx.user))
        present, _ = self._own_entry(ctx, hour)
        if present:
            return ()
        return (hours_key(ctx.user.id, hour, "acted"), hours_key(ctx.user.id, hour, "dismissed"))

    def run(self, ctx: Context, values: Values) -> Outcome:
        if not self._judged(ctx):
            return PASS
        hour = hour_of_day(ctx.now, effective_zone(ctx.user))
        present, entry = self._own_entry(ctx, hour)
        if present:
            acted = _count(entry.get("acted")) if isinstance(entry, Mapping) else 0.0
            dismissed = _count(entry.get("dismissed")) if isinstance(entry, Mapping) else 0.0
        else:
            acted = _count(values.get(hours_key(ctx.user.id, hour, "acted")))
            dismissed = _count(values.get(hours_key(ctx.user.id, hour, "dismissed")))
        total = acted + dismissed
        if not math.isfinite(total) or total == 0 or total < self.min_samples or acted / total >= self.max_act_rate:
            return PASS
        surfaces = tuple(s for s in ctx.surfaces if s != "push")
        return Outcome("adjust", f"dead hour {hour}:00: {_num(acted)} of {_num(total)} acted on; push removed for {ctx.candidate.id}", surfaces=surfaces)


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


def dedupe_key_for(user_id: str, key: str) -> str:
    return f"dedupe:{user_id}:{key}"


def _human_window(seconds: int) -> str:
    if seconds % DAY_SECONDS == 0:
        return f"{seconds // DAY_SECONDS}d"
    if seconds % 3600 == 0:
        return f"{seconds // 3600}h"
    if seconds % 60 == 0:
        return f"{seconds // 60}m"
    return f"{seconds}s"


class Dedupe(BaseCheck):
    """One delivery per event per window, claimed atomically at commit time.

    Transports deliver at least once, so the same event arrives twice, and two
    workers can hold it at the same moment. Both then evaluate against a store
    where nothing is recorded, so reading cannot separate them: the claim has to
    be atomic and it has to happen at commit. See spec clauses 5.5 to 5.8.

    The window is the caller's; the 24-hour default is the common retry horizon,
    the same figure Stripe prunes an idempotency key after and Nylas gives as the
    safe default for webhook deduplication.
    """

    id = "dedupe"

    def __init__(self, window_seconds: int = DAY_SECONDS) -> None:
        self.window_seconds = window_seconds
        self.label = _human_window(window_seconds)

    def _key(self, ctx: Context) -> str | None:
        key = getattr(ctx.candidate, "dedupe_key", None)
        return dedupe_key_for(ctx.user.id, key) if key else None

    def keys(self, ctx: Context) -> Sequence[str]:
        key = self._key(ctx)
        return (key,) if key else ()

    def run(self, ctx: Context, values: Values) -> Outcome:
        key = self._key(ctx)
        if key is None:
            return skip("no dedupeKey on the candidate; deduplication cannot be evaluated")
        return PASS if values.get(key) is None else reject(f"already delivered within the last {self.label}")

    def consume_plan(self, ctx: Context) -> ConsumePlan | None:
        key = self._key(ctx)
        return None if key is None else ConsumePlan(key, self.window_seconds, 1)


def default_checks(
    kill_switch: Callable[[], bool] | bool = False,
    modes: Sequence[str] = ("normal",),
    daily_limit: int = 5,
    weekly_limit: int | None = None,
    quiet_hours_floor: str = "critical",
) -> list[Check]:
    """The default order, as a starting point."""
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
    "CrisisQuiet", "DailyBudget", "DeadHours", "Dedupe", "DismissalCooldown", "Enabled", "Freshness", "Intensity",
    "KillSwitch", "KillSwitchFlag", "Mode", "MonthlyBudget", "Mute", "OnlyWhen", "QuietHours", "RateLimit",
    "RecentInteraction", "RequiresConsent", "Silence", "Snooze", "TrustRamp", "UtilityFloor", "WeeklyBudget",
    "WindowBudget", "budget_key", "default_checks", "dismissal_key", "dedupe_key_for", "hours_key",
    "monthly_budget_key", "weekly_budget_key",
]
