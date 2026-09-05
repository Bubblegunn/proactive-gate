# proactive-gate for Python

Decide whether a proactive assistant may speak to this person right now. Ordered checks
(consent, mode, snooze, mute, intensity, quiet hours, trust ramp, dismissal cooldown,
budgets), JSON policies, platform and regulatory presets, and a trace that says which check
stopped the message and why.

This is the Python sibling of the TypeScript package. Both implement the same behaviour
contract in [`spec/`](https://github.com/Bubblegunn/proactive-gate/tree/main/spec) and run
the same fixtures, so a policy written for one behaves the same in the other.

Until the first PyPI release, install from the repository:

```
git clone https://github.com/Bubblegunn/proactive-gate
pip install ./proactive-gate/python
```

or, without cloning, `pip install "proactive-gate @ git+https://github.com/Bubblegunn/proactive-gate#subdirectory=python"`.
Python 3.11 or newer, no runtime dependencies. Add `[redis]` (`pip install "./proactive-gate/python[redis]"`)
for the Redis store. The PyPI name `proactive-gate` is reserved for this package; the
release workflow publishes there on the next tag.

## Use

```python
from datetime import datetime, timezone
from proactive_gate import Candidate, EvaluateInput, Gate, UserState, default_checks

gate = Gate(default_checks(daily_limit=3))
user = UserState.from_dict({
    "id": "u1", "consent": True, "timezone": "Europe/Istanbul",
    "quietHours": {"start": "22:00", "end": "08:00"}, "createdAt": "2026-01-01T00:00:00Z",
})
candidate = Candidate(id="c1", type="reminder", priority="normal", surfaces=("push", "feed"))
inp = EvaluateInput(user, candidate, datetime.now(timezone.utc))

decision = gate.evaluate(inp)
if decision.allowed and gate.commit(decision, inp):
    send(candidate, decision.surfaces)
else:
    print(decision.rejected_by, decision.reason)
```

`evaluate` reads; `commit` is the atomic increment right before you send, and it is
idempotent on `decision.id`. Every decision carries `trace`, one entry per check that ran.

## A policy is data

```python
import json
from proactive_gate import Gate

gate = Gate.from_policy(json.load(open("policy.json")))
```

`policy.json` is the same document the TypeScript package and the CLI read
(`{"specVersion": "1.0.0", "checks": [{"id": "consent"}, {"preset": "usTcpa"}, ...]}`).
Unknown check ids and presets raise `ValueError` naming the known ones; `shadow: true`
keeps a check observing without letting it decide.

## Async

```python
from proactive_gate import AsyncGate, RedisStore
import redis.asyncio as redis

gate = AsyncGate.from_policy(policy, RedisStore(redis.from_url("redis://localhost")))
decision = await gate.evaluate(inp)
```

`Gate` and `AsyncGate` share one decision loop (`Evaluation`): a check names the store keys
it needs and decides purely from their values, so the two gates cannot drift. `decide()`
runs that loop with values you supply, for tests with no store at all.

## Stores

`MemoryStore` (in-process), `SqliteStore` (standard library, one file per host),
`AsyncMemoryStore`, and `RedisStore` over `redis.asyncio` (INCR, then EXPIRE on the first
increment). Any object with `get`, `set`, `incr` and `delete` works.

## Presets

`proactive_gate.presets` holds the same fourteen presets as the TypeScript package, each with
its source URLs and a note on what it leaves out: LINE, WeChat, WeCom, Kakao, Korea's Network
Act, Japan's anti-spam law, China's minor mode, US TCPA, EU ePrivacy, Telegram and Slack.
They are reviewable defaults, not legal advice.

## Conformance

```
pytest
```

runs every fixture under `../spec/fixtures` through both gates. A fixture the Python package
cannot yet satisfy is listed in `spec/skip/python.txt` with a reason; the list is empty.

## License

MIT.
