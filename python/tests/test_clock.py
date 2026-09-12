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


def test_local_day_is_four_digits_whatever_the_year() -> None:
    """``strftime("%Y")`` pads on most builds and not on all of them (#38).

    The day string is built from the fields instead, so the result does not depend on which
    C library the interpreter was linked against. Two interpreters on one machine disagreed
    about this before the fix, which is the worst kind of test to have to debug.
    """
    for year, expected in ((1, "0001-06-01"), (99, "0099-06-01"), (999, "0999-06-01"), (2026, "2026-06-01")):
        now = datetime(year, 6, 1, 12, 0, tzinfo=timezone.utc)
        assert local_clock(now, "UTC") == (720, expected)


def test_iso_week_key_pads_the_year_to_the_spec_format() -> None:
    """5.1 fixes the key format at ``YYYY-Www``; this emitted ``1-W22`` (#37).

    The TypeScript sibling writes ``0001-W22`` for the same instant, so an unpadded key here
    meant one store served two sets of counters without either side noticing.
    """
    assert iso_week_key("0001-06-01") == "0001-W22"
    assert iso_week_key("0999-06-01") == "0999-W22"
