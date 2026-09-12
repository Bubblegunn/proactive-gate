#!/usr/bin/env python3
"""The (zone, instant) pairs the clock sweep renders.

One line per pair: ``ZONE<TAB>INSTANT``, instants in UTC. Two passes: every zone
twice a day from 2011 to 2029, then fifteen-minute sweeps across the transitions
a day-grain pass could step over. Deterministic; both renderers read it on stdin
so a diff of their outputs can only come from the tz data each one carries.
"""
from datetime import datetime, timedelta, timezone

Z = timezone.utc

# Zones chosen for an offset that is not a whole hour, a transition that is not an
# hour, a rule that changed recently, or a day that skipped or repeated.
ZONES = [
    "America/Mexico_City", "America/Ciudad_Juarez", "America/Nuuk", "America/Coyhaique",
    "Asia/Beirut", "Asia/Gaza", "Asia/Hebron", "Africa/Casablanca", "Africa/El_Aaiun",
    "Asia/Almaty", "Asia/Qostanay", "Antarctica/Casey", "Pacific/Kanton",
    "Asia/Kathmandu", "Pacific/Chatham", "Australia/Lord_Howe", "America/St_Johns",
    "Australia/Adelaide", "Australia/Eucla",
    "Pacific/Apia", "Pacific/Kiritimati", "America/New_York", "Europe/Istanbul",
    "Australia/Sydney", "Asia/Tokyo", "UTC",
]


def emit(zone: str, dt: datetime) -> None:
    print(f"{zone}\t{dt.strftime('%Y-%m-%dT%H:%M:%SZ')}")


def dense(zone: str, a: datetime, b: datetime, step_min: int = 15) -> None:
    t = a
    while t <= b:
        emit(zone, t)
        t += timedelta(minutes=step_min)


start = datetime(2011, 1, 1, tzinfo=Z)
end = datetime(2030, 1, 1, tzinfo=Z)
d = start
while d < end:
    for zone in ZONES:
        emit(zone, d)
        emit(zone, d + timedelta(hours=12))
    d += timedelta(days=1)

dense("America/New_York", datetime(2026, 3, 8, 5, 0, tzinfo=Z), datetime(2026, 3, 8, 9, 0, tzinfo=Z))
dense("America/New_York", datetime(2026, 11, 1, 4, 0, tzinfo=Z), datetime(2026, 11, 1, 8, 0, tzinfo=Z))
dense("Australia/Lord_Howe", datetime(2026, 10, 3, 15, 0, tzinfo=Z), datetime(2026, 10, 4, 17, 0, tzinfo=Z))
dense("Australia/Lord_Howe", datetime(2026, 4, 4, 15, 0, tzinfo=Z), datetime(2026, 4, 5, 17, 0, tzinfo=Z))
dense("America/Mexico_City", datetime(2026, 4, 5, 6, 0, tzinfo=Z), datetime(2026, 4, 5, 10, 0, tzinfo=Z))
dense("Africa/Casablanca", datetime(2026, 2, 14, 22, 0, tzinfo=Z), datetime(2026, 2, 16, 2, 0, tzinfo=Z))
dense("Africa/Casablanca", datetime(2026, 3, 21, 22, 0, tzinfo=Z), datetime(2026, 3, 23, 2, 0, tzinfo=Z))
dense("Pacific/Apia", datetime(2011, 12, 29, 9, 0, tzinfo=Z), datetime(2011, 12, 30, 11, 0, tzinfo=Z))
dense("Asia/Almaty", datetime(2024, 2, 29, 17, 0, tzinfo=Z), datetime(2024, 3, 1, 20, 0, tzinfo=Z))
dense("Asia/Beirut", datetime(2023, 3, 25, 20, 0, tzinfo=Z), datetime(2023, 3, 27, 4, 0, tzinfo=Z))
dense("Asia/Beirut", datetime(2023, 4, 20, 20, 0, tzinfo=Z), datetime(2023, 4, 21, 4, 0, tzinfo=Z))
dense("America/Nuuk", datetime(2023, 10, 28, 22, 0, tzinfo=Z), datetime(2023, 10, 30, 2, 0, tzinfo=Z))
dense("Asia/Gaza", datetime(2026, 3, 27, 20, 0, tzinfo=Z), datetime(2026, 3, 29, 4, 0, tzinfo=Z))
dense("Pacific/Chatham", datetime(2026, 4, 4, 14, 0, tzinfo=Z), datetime(2026, 4, 5, 16, 0, tzinfo=Z))
dense("Pacific/Chatham", datetime(2026, 9, 26, 14, 0, tzinfo=Z), datetime(2026, 9, 27, 16, 0, tzinfo=Z))

for base in [datetime(2025, 12, 28, tzinfo=Z), datetime(2026, 12, 28, tzinfo=Z), datetime(2020, 12, 28, tzinfo=Z)]:
    t = base
    while t < base + timedelta(days=8):
        emit("Europe/Istanbul", t)
        emit("Pacific/Apia", t)
        emit("America/New_York", t)
        t += timedelta(hours=1)

dense("UTC", datetime(2028, 2, 29, 0, 0, tzinfo=Z), datetime(2028, 3, 1, 12, 0, tzinfo=Z), 30)
dense("Pacific/Apia", datetime(2028, 2, 28, 12, 0, tzinfo=Z), datetime(2028, 3, 1, 12, 0, tzinfo=Z), 30)
dense("UTC", datetime(2016, 12, 31, 22, 0, tzinfo=Z), datetime(2017, 1, 1, 2, 0, tzinfo=Z))
