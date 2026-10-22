# Reference for Y6, Python. Reads policy.json from the current folder and the case file named in sys.argv[1].
# Rules, the first that applies wins: requireConsent and no consent -> consent; normal case inside local quiet hours
# (start inclusive, end exclusive, may cross midnight) -> quiet; the user already has dailyCap sent calls on the same
# local day in the case's timezone -> cap; otherwise sent. A null quietHours or dailyCap disables that rule.
import json
import sys
from datetime import datetime
from zoneinfo import ZoneInfo


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)


try:
    with open("policy.json", encoding="utf-8") as f:
        policy = json.load(f)
except FileNotFoundError:
    fail("policy.json is missing from the current folder")
except (OSError, ValueError) as e:
    fail(f"policy.json is not valid JSON: {e}")
if not isinstance(policy, dict):
    fail("policy.json must hold a JSON object")

with open(sys.argv[1], encoding="utf-8") as f:
    cases = json.load(f)


def to_minutes(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


quiet = None
if policy.get("quietHours") is not None:
    quiet = (to_minutes(policy["quietHours"]["start"]), to_minutes(policy["quietHours"]["end"]))
daily_cap = policy.get("dailyCap")
require_consent = bool(policy.get("requireConsent"))


def in_quiet(minute):
    start, end = quiet
    if start < end:
        return start <= minute < end
    return minute >= start or minute < end


counts = {}
out = []
for index, c in enumerate(cases):
    local = datetime.fromisoformat(c["at"]).astimezone(ZoneInfo(c["timezone"]))
    day = local.date().isoformat()
    minute = local.hour * 60 + local.minute
    if require_consent and not c["consent"]:
        outcome = "consent"
    elif quiet is not None and c["priority"] != "critical" and in_quiet(minute):
        outcome = "quiet"
    else:
        key = (c["userId"], day)
        n = counts.get(key, 0)
        if daily_cap is not None and n >= daily_cap:
            outcome = "cap"
        else:
            outcome = "sent"
            counts[key] = n + 1
    out.append({"index": index, "outcome": outcome})
print(json.dumps(out))
