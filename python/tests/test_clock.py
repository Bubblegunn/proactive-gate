from datetime import datetime, timezone

import pytest

from proactive_gate.clock import in_window, iso_week_key, local_clock, parse_hhmm


def test_local_clock_handles_zones_and_dst() -> None:
    minutes, day = local_clock(datetime(2026, 9, 4, 9, 0, tzinfo=timezone.utc), "Europe/Istanbul")
    assert (minutes, day) == (12 * 60, "2026-09-04")
    # New York springs forward on 2026-03-08 at 02:00: 06:30Z is 01:30 EST, 07:30Z is 03:30 EDT.
    assert local_clock(datetime(2026, 3, 8, 6, 30, tzinfo=timezone.utc), "America/New_York")[0] == 90
    assert local_clock(datetime(2026, 3, 8, 7, 30, tzinfo=timezone.utc), "America/New_York")[0] == 210
    # Apia is UTC+13: 11:00Z is midnight the next day.
    assert local_clock(datetime(2026, 9, 4, 11, 0, tzinfo=timezone.utc), "Pacific/Apia") == (0, "2026-09-05")


def test_in_window_crosses_midnight() -> None:
    start, end = parse_hhmm("22:00"), parse_hhmm("08:00")
    assert in_window(parse_hhmm("23:30"), start, end)
    assert in_window(parse_hhmm("07:59"), start, end)
    assert not in_window(parse_hhmm("08:00"), start, end)
    assert not in_window(parse_hhmm("12:00"), start, end)
    assert not in_window(600, 600, 600)


def test_parse_hhmm_rejects_garbage() -> None:
    with pytest.raises(ValueError):
        parse_hhmm("noon")


def test_iso_week_key_uses_the_iso_year() -> None:
    assert iso_week_key("2026-01-01") == "2026-W01"
    assert iso_week_key("2027-01-01") == "2026-W53"
    assert iso_week_key("2026-09-07") == "2026-W37"
