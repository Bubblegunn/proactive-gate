# Broken A for Y6, Python. Mistake 1: the policy is hard-coded (it never reads policy.json).
# Mistake 2: the day that counts toward the cap is the UTC calendar date, not the case's local day.
# Quiet hours use the local clock, so only the cap and the missing policy read are wrong.
# Expected FAILS: 2 (python on policy A: the UTC day changes cap results), 4 (policy swap ignored), 5 (N1 and N2 variants
# ignore the null rules), 6 (no error for missing or invalid policy.json).
import json
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

QUIET = (22 * 60, 7 * 60)
DAILY_CAP = 3
REQUIRE_CONSENT = True

with open(sys.argv[1], encoding="utf-8") as f:
    cases = json.load(f)


def in_quiet(minute):
    start, end = QUIET
    if start < end:
        return start <= minute < end
    return minute >= start or minute < end


counts = {}
out = []
for index, c in enumerate(cases):
    instant = datetime.fromisoformat(c["at"])
    local = instant.astimezone(ZoneInfo(c["timezone"]))
    day = instant.date().isoformat()
    minute = local.hour * 60 + local.minute
    if REQUIRE_CONSENT and not c["consent"]:
        outcome = "consent"
    elif c["priority"] != "critical" and in_quiet(minute):
        outcome = "quiet"
    else:
        key = (c["userId"], day)
        n = counts.get(key, 0)
        if n >= DAILY_CAP:
            outcome = "cap"
        else:
            outcome = "sent"
            counts[key] = n + 1
    out.append({"index": index, "outcome": outcome})
print(json.dumps(out))
