# The Python half of the clock sweep: render each (zone, instant) pair's local
# time through zoneinfo, the same path `local_clock` in checks.py uses. See
# bench/clock-sweep.mjs for the two commands and what a diff line means.
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

for line in sys.stdin:
    t = line.strip()
    if not t or t.startswith("#"):
        continue
    zone, iso = t.split()
    try:
        now = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        local = now.astimezone(ZoneInfo(zone))
        print(f"{zone}\t{iso}\t{local.strftime('%Y-%m-%d %H:%M:%S')}")
    except Exception as e:
        print(f"{zone}\t{iso}\tTHROW {type(e).__name__}")
