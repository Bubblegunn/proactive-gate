"""Every fixture under spec/fixtures, through the sync and the async gate."""
from __future__ import annotations

import asyncio
from typing import Any

import pytest

from conftest import FIXTURES, SKIPS, SPEC_VERSION
from proactive_gate.conformance import load_fixtures, read_skips, run_fixture, run_fixture_async

FIXTURE_LIST = list(load_fixtures(FIXTURES))
SKIP = read_skips(SKIPS)


def _params() -> list[Any]:
    out: list[Any] = []
    for fixture in FIXTURE_LIST:
        marks = [pytest.mark.skip(reason=SKIP[fixture["name"]])] if fixture["name"] in SKIP else []
        out.append(pytest.param(fixture, id=fixture["name"], marks=marks))
    return out


def test_fixtures_exist_and_target_the_current_spec() -> None:
    assert len(FIXTURE_LIST) >= 10
    for fixture in FIXTURE_LIST:
        assert fixture["spec_version"] == SPEC_VERSION, fixture["name"]


@pytest.mark.parametrize("fixture", _params())
def test_sync_gate_conforms(fixture: dict[str, Any]) -> None:
    assert run_fixture(fixture) == []


@pytest.mark.parametrize("fixture", _params())
def test_async_gate_conforms(fixture: dict[str, Any]) -> None:
    assert asyncio.run(run_fixture_async(fixture)) == []
