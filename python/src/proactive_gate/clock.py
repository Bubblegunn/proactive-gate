"""Local-time arithmetic with the standard library only."""
from __future__ import annotations

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

DAY_SECONDS = 24 * 60 * 60


def local_clock(now: datetime, tz: str) -> tuple[int, str]:
    """Minutes since local midnight and the local calendar day, ``YYYY-MM-DD``."""
    local = now.astimezone(ZoneInfo(tz))
    return local.hour * 60 + local.minute, local.strftime("%Y-%m-%d")


def parse_hhmm(text: str) -> int:
    parts = text.split(":")
    if len(parts) != 2 or not all(p.isdigit() for p in parts):
        raise ValueError(f'bad time "{text}", expected HH:MM')
    return int(parts[0]) * 60 + int(parts[1])


def in_window(minutes: int, start: int, end: int) -> bool:
    """True when ``minutes`` falls inside [start, end); the window may cross midnight."""
    if start == end:
        return False
    if start < end:
        return start <= minutes < end
    return minutes >= start or minutes < end


def local_day(now: datetime, tz: str | None) -> str:
    if tz:
        return local_clock(now, tz)[1]
    return now.astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%d")


def iso_week_key(day: str) -> str:
    year, week, _ = datetime.strptime(day, "%Y-%m-%d").isocalendar()
    return f"{year}-W{week:02d}"


WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def weekday_of(day: str) -> str:
    """The weekday of a local calendar date, ``"mon"`` to ``"sun"``.

    Calendar arithmetic on the date ``local_clock`` already resolved, never arithmetic
    on an instant, so a 45-minute offset or a daylight-saving change cannot reach it.
    """
    return WEEKDAYS[date.fromisoformat(day).weekday()]


def day_before(day: str) -> str:
    return (date.fromisoformat(day) - timedelta(days=1)).isoformat()
