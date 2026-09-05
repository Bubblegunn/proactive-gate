"""Runs the language-neutral fixtures under ``spec/fixtures`` against ``Gate`` or ``AsyncGate``."""
from __future__ import annotations

import json
import re
from collections.abc import Iterator, Mapping
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .gate import AsyncGate, Gate
from .stores import AsyncMemoryStore, MemoryStore
from .types import Candidate, Decision, EvaluateInput, UserState, iso_z, to_datetime


def load_fixtures(directory: str | Path) -> Iterator[dict[str, Any]]:
    for path in sorted(Path(directory).rglob("*.json")):
        with path.open(encoding="utf-8") as handle:
            fixture: dict[str, Any] = json.load(handle)
            yield fixture


def read_skips(path: str | Path) -> dict[str, str]:
    skips: dict[str, str] = {}
    try:
        text = Path(path).read_text(encoding="utf-8")
    except FileNotFoundError:
        return skips
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name, _, reason = line.partition("#")
        skips[name.strip()] = reason.strip()
    return skips


def _input(test: Mapping[str, Any]) -> EvaluateInput:
    raw = test["input"]
    now = to_datetime(raw["now"])
    if now is None:
        raise ValueError(f"bad now {raw['now']!r}")
    return EvaluateInput(UserState.from_dict(raw["user"]), Candidate.from_dict(raw["candidate"]), now)


def _compare(failures: list[str], at: str, decision: Decision, expect: Mapping[str, Any]) -> None:
    def check(field: str, actual: object, expected: object) -> None:
        if json.dumps(actual, sort_keys=True) != json.dumps(expected, sort_keys=True):
            failures.append(f"{at}: {field} expected {json.dumps(expected)}, got {json.dumps(actual)}")

    check("allowed", decision.allowed, expect["allowed"])
    check("trace", [t.id for t in decision.trace], expect["trace"])
    check("rejectedBy", decision.rejected_by, expect.get("rejectedBy"))
    check("deferredBy", decision.deferred_by, expect.get("deferredBy"))
    check("retryAt", iso_z(decision.retry_at) if decision.retry_at else None, expect.get("retryAt"))
    if "surfaces" in expect:
        check("surfaces", list(decision.surfaces), expect["surfaces"])
    check("deliverAt", iso_z(decision.deliver_at) if decision.deliver_at else None, expect.get("deliverAt"))
    if "shadowed" in expect:
        check("shadowed", list(decision.shadowed), expect["shadowed"])
    if "nearLimit" in expect:
        check("nearLimit", [asdict(n) for n in decision.near_limit], expect["nearLimit"])
    pattern = expect.get("reason_pattern")
    if pattern and not (decision.reason and re.search(pattern, decision.reason)):
        failures.append(f"{at}: reason {json.dumps(decision.reason)} does not match /{pattern}/")


def run_fixture(fixture: Mapping[str, Any]) -> list[str]:
    """Synchronous gate. Returns the mismatches; empty means the fixture conforms."""
    failures: list[str] = []
    store = MemoryStore()
    prefix = fixture["policy"].get("keyPrefix", "pg:")
    for key, value in (fixture.get("store_seed") or {}).items():
        store.set(prefix + key, value)
    try:
        gate = Gate.from_policy(fixture["policy"], store)
    except ValueError as error:
        return _policy_error(fixture, failures, str(error))
    for i, test in enumerate(fixture["tests"]):
        at = f"{fixture['name']} [{i}] {test['description']}"
        inp = _input(test)
        decision = gate.evaluate(inp)
        expect = test["expect"]
        _compare(failures, at, decision, expect)
        if test.get("commit"):
            committed = gate.commit(decision, inp)
            if "commit" in expect and committed != expect["commit"]:
                failures.append(f"{at}: commit expected {expect['commit']}, got {committed}")
        for key, value in (expect.get("store_after") or {}).items():
            actual = store.get(prefix + key)
            if actual != value:
                failures.append(f"{at}: store {key} expected {json.dumps(value)}, got {json.dumps(actual)}")
    return failures


async def run_fixture_async(fixture: Mapping[str, Any]) -> list[str]:
    """The same fixture through ``AsyncGate`` and ``AsyncMemoryStore``."""
    failures: list[str] = []
    store = AsyncMemoryStore()
    prefix = fixture["policy"].get("keyPrefix", "pg:")
    for key, value in (fixture.get("store_seed") or {}).items():
        await store.set(prefix + key, value)
    try:
        gate = AsyncGate.from_policy(fixture["policy"], store)
    except ValueError as error:
        return _policy_error(fixture, failures, str(error))
    for i, test in enumerate(fixture["tests"]):
        at = f"{fixture['name']} [{i}] {test['description']}"
        inp = _input(test)
        decision = await gate.evaluate(inp)
        expect = test["expect"]
        _compare(failures, at, decision, expect)
        if test.get("commit"):
            committed = await gate.commit(decision, inp)
            if "commit" in expect and committed != expect["commit"]:
                failures.append(f"{at}: commit expected {expect['commit']}, got {committed}")
        for key, value in (expect.get("store_after") or {}).items():
            actual = await store.get(prefix + key)
            if actual != value:
                failures.append(f"{at}: store {key} expected {json.dumps(value)}, got {json.dumps(actual)}")
    return failures


def _policy_error(fixture: Mapping[str, Any], failures: list[str], message: str) -> list[str]:
    """A fixture whose policy must fail to compile says so through a test whose expect carries ``policy_error``."""
    for i, test in enumerate(fixture["tests"]):
        pattern = test["expect"].get("reason_pattern")
        if pattern and re.search(pattern, message):
            continue
        failures.append(f"{fixture['name']} [{i}] {test['description']}: policy failed to compile: {message}")
    return failures


__all__ = ["load_fixtures", "read_skips", "run_fixture", "run_fixture_async"]
