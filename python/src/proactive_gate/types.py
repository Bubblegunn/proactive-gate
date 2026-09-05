"""Frozen data the gate reads and writes. Field names are snake_case; the JSON
fixtures and policies use the camelCase of the TypeScript package, and
``from_dict`` maps between them."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal, Mapping, Sequence

Priority = Literal["low", "normal", "high", "critical"]
PRIORITY_RANK: dict[str, int] = {"low": 0, "normal": 1, "high": 2, "critical": 3}
Intensity = Literal["low", "normal", "high"]
OutcomeKind = Literal["pass", "reject", "adjust", "skip", "defer"]
OutcomeEvent = Literal["delivered", "dismissed", "acted", "ignored"]
StoreErrorMode = Literal["open", "closed"]

UTC = timezone.utc


def to_datetime(value: object) -> datetime | None:
    """A datetime, an ISO-8601 string (``Z`` accepted) or epoch milliseconds; anything else is None."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return datetime.fromtimestamp(value / 1000, tz=UTC)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    return None


def iso_z(value: datetime) -> str:
    """The JavaScript ``toISOString`` form: UTC, milliseconds, trailing Z."""
    utc = value.astimezone(UTC)
    return f"{utc.strftime('%Y-%m-%dT%H:%M:%S')}.{utc.microsecond // 1000:03d}Z"


def epoch_ms(value: datetime) -> int:
    return int(round(value.timestamp() * 1000))


@dataclass(frozen=True, slots=True)
class QuietWindow:
    start: str
    end: str


@dataclass(frozen=True, slots=True)
class QuietSchedule:
    """Quiet hours resolved per day: a date beats a weekday beats the default.

    ``None`` at any level means the day has no quiet hours, which is how a working
    day is carved out of a default. There is no bundled holiday calendar; the dates
    a caller observes are the caller's to supply.
    """

    default: QuietWindow | None = None
    days: Mapping[str, QuietWindow | None] = field(default_factory=dict)
    dates: Mapping[str, QuietWindow | None] = field(default_factory=dict)


# The single-window form every caller had before schedules existed.
QuietHours = QuietWindow


def _window(value: Any) -> QuietWindow | None:
    return QuietWindow(str(value["start"]), str(value["end"])) if value else None


def parse_quiet_hours(value: Any) -> QuietWindow | QuietSchedule | None:
    """A window, or a schedule; the two forms are told apart by the ``start`` key."""
    if not value:
        return None
    if "start" in value:
        return _window(value)
    return QuietSchedule(
        default=_window(value.get("default")),
        days={k: _window(v) for k, v in (value.get("days") or {}).items()},
        dates={k: _window(v) for k, v in (value.get("dates") or {}).items()},
    )


@dataclass(frozen=True, slots=True)
class UserState:
    id: str
    consent: bool
    proactive_enabled: bool | None = None
    mode: str | None = None
    snoozed_until: datetime | None = None
    muted_types: tuple[str, ...] = ()
    intensity: Intensity | None = None
    timezone: str | None = None
    quiet_hours: QuietWindow | QuietSchedule | None = None
    created_at: datetime | None = None
    surfaces: tuple[str, ...] | None = None
    consents: Mapping[str, bool] = field(default_factory=dict)
    last_inbound_at: datetime | None = None
    minor: bool | None = None
    existing_customer: bool | None = None

    @staticmethod
    def from_dict(data: Mapping[str, Any]) -> "UserState":
        qh = data.get("quietHours")
        return UserState(
            id=str(data["id"]),
            consent=bool(data.get("consent", False)),
            proactive_enabled=data.get("proactiveEnabled"),
            mode=data.get("mode"),
            snoozed_until=to_datetime(data.get("snoozedUntil")),
            muted_types=tuple(data.get("mutedTypes") or ()),
            intensity=data.get("intensity"),
            timezone=data.get("timezone"),
            quiet_hours=parse_quiet_hours(qh),
            created_at=to_datetime(data.get("createdAt")),
            surfaces=tuple(data["surfaces"]) if data.get("surfaces") is not None else None,
            consents=dict(data.get("consents") or {}),
            last_inbound_at=to_datetime(data.get("lastInboundAt")),
            minor=data.get("minor"),
            existing_customer=data.get("existingCustomer"),
        )


@dataclass(frozen=True, slots=True)
class Candidate:
    id: str
    type: str
    priority: Priority = "normal"
    surfaces: tuple[str, ...] = ("feed",)
    channel: str | None = None
    busy: bool | None = None
    p_accept: float | None = None
    p_need: float | None = None
    payload: Any = None

    @staticmethod
    def from_dict(data: Mapping[str, Any]) -> "Candidate":
        return Candidate(
            id=str(data["id"]),
            type=str(data["type"]),
            priority=data.get("priority") or "normal",
            surfaces=tuple(data.get("surfaces") or ("feed",)),
            channel=data.get("channel"),
            busy=data.get("busy"),
            p_accept=data.get("pAccept"),
            p_need=data.get("pNeed"),
            payload=data.get("payload"),
        )


@dataclass(frozen=True, slots=True)
class NearLimit:
    used: int
    limit: int


@dataclass(frozen=True, slots=True)
class Outcome:
    """What a single check says. ``kind`` decides which other fields matter."""

    kind: OutcomeKind
    reason: str | None = None
    retry_at: datetime | None = None
    deliver_at: datetime | None = None
    surfaces: tuple[str, ...] | None = None
    near_limit: NearLimit | None = None


PASS = Outcome("pass")


def reject(reason: str) -> Outcome:
    return Outcome("reject", reason)


def skip(reason: str) -> Outcome:
    return Outcome("skip", reason)


def defer(reason: str, retry_at: datetime) -> Outcome:
    return Outcome("defer", reason, retry_at=retry_at)


@dataclass(frozen=True, slots=True)
class Context:
    user: UserState
    candidate: Candidate
    now: datetime
    priority: Priority
    surfaces: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class TraceEntry:
    id: str
    outcome: OutcomeKind
    ms: float
    reason: str | None = None
    shadow: bool = False


@dataclass(frozen=True, slots=True)
class NearLimitNote:
    check: str
    used: int
    limit: int


@dataclass(frozen=True, slots=True)
class Decision:
    id: str
    allowed: bool
    user_id: str
    candidate_id: str
    surfaces: tuple[str, ...]
    trace: tuple[TraceEntry, ...]
    evaluated_at: datetime
    shadowed: tuple[str, ...] = ()
    near_limit: tuple[NearLimitNote, ...] = ()
    deliver_at: datetime | None = None
    rejected_by: str | None = None
    deferred_by: str | None = None
    retry_at: datetime | None = None
    reason: str | None = None


@dataclass(frozen=True, slots=True)
class EvaluateInput:
    user: UserState
    candidate: Candidate
    now: datetime | None = None


@dataclass(frozen=True, slots=True)
class ConsumePlan:
    """A budget-like check's commit-time increment: the key, its TTL and the limit the new value must not exceed."""

    key: str
    ttl_seconds: int
    limit: int


def at_least(priority: str, floor: str) -> bool:
    return PRIORITY_RANK[priority] >= PRIORITY_RANK[floor]


def surfaces_for(user: UserState, candidate: Candidate) -> tuple[str, ...]:
    wanted: Sequence[str] = candidate.surfaces or ("feed",)
    if user.surfaces is None:
        return tuple(wanted)
    allowed = set(user.surfaces)
    return tuple(s for s in wanted if s in allowed)
