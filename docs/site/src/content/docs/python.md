---
title: Python
description: The Python sibling, held to the same fixtures.
---

```
pip install proactive-gate
```

Python 3.11 or newer, no runtime dependencies; add `[redis]` for the Redis store. To run an
unreleased state, install from the repository instead: `pip install "proactive-gate @
git+https://github.com/Bubblegunn/proactive-gate#subdirectory=python"`.

The published 0.2.1 was uploaded from a local build with a token, so unlike the npm package it
carries no build provenance.

```python
from datetime import datetime, timezone
from proactive_gate import Candidate, EvaluateInput, Gate, UserState, default_checks

gate = Gate(default_checks(daily_limit=3))
user = UserState.from_dict({"id": "u1", "consent": True, "timezone": "Europe/Istanbul"})
candidate = Candidate(id="c1", type="reminder", surfaces=("push", "feed"))
inp = EvaluateInput(user, candidate, datetime.now(timezone.utc))

decision = gate.evaluate(inp)
if decision.allowed and gate.commit(decision, inp):
    send(candidate, decision.surfaces)
```

`Gate.from_policy(policy_dict, store)` compiles the same JSON policy. `AsyncGate` takes an
`AsyncStore` (`AsyncMemoryStore`, `RedisStore` over `redis.asyncio`). The two gates share one
decision loop: a check names the store keys it needs and decides purely from their values, so
they cannot drift, and `decide()` runs that loop with values you supply for tests with no store.

The package passes every fixture under `spec/fixtures` through both gates, on Python 3.11 and
3.13 in CI. Field names are snake_case in Python; `from_dict` accepts the camelCase the
fixtures and policies use.
