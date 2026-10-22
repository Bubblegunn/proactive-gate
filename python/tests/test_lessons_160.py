"""Spec 1.6.0 edge cases the shared fixtures under spec/fixtures/lessons do not cover.

The fixtures pin the behaviour; these tests pin what a fixture cannot say: a zone string that is
not a zone, a consent lookup that failed with no fail mode, a commitment through the whole
assistantNudge preset, a malformed hour entry, a policy that must not compile, and a store that
offers only the Store protocol.
"""
from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

import pytest

from proactive_gate import Candidate, EvaluateInput, Gate, MemoryStore, UserState, decide
from proactive_gate.checks import Consent, KillSwitchFlag, Silence, budget_key, effective_zone, hour_of_day, hours_key
from proactive_gate.policy import compile_policy
from proactive_gate.types import to_datetime

NOW = datetime(2026, 9, 4, 12, 0, tzinfo=UTC)
PREFIX = "pg:"


def nudge_policy(**options: Any) -> dict[str, Any]:
    return {"specVersion": "1.0.0", "checks": [{"preset": "assistantNudge", **options}]}


def user(**overrides: Any) -> UserState:
    data: dict[str, Any] = {"id": "u1", "consent": True, "createdAt": "2026-07-01T00:00:00Z", "consents": {"marketing": True}}
    data.update(overrides)
    return UserState.from_dict(data)


def test_a_device_zone_that_is_not_a_zone_is_ignored() -> None:
    assert effective_zone(user(timezone="Europe/Istanbul", deviceTimezone="Mars/Olympus")) == "Europe/Istanbul"
    assert effective_zone(user(deviceTimezone="Mars/Olympus")) is None


def test_consent_unknown_with_no_fail_mode_closes_every_surface() -> None:
    candidate = Candidate.from_dict({"id": "c1", "type": "insight", "surfaces": ["push", "feed"]})
    decision = decide([Consent()], EvaluateInput(user(consentUnknown=True), candidate, NOW))
    assert decision.allowed is False
    assert decision.rejected_by == "consent"
    assert decision.reason is not None and "could not be determined" in decision.reason


def test_a_commitment_through_the_whole_preset_spends_nothing() -> None:
    gate = Gate.from_policy(nudge_policy(dailyLimit=1), MemoryStore())
    commitment = Candidate.from_dict({"id": "c1", "type": "reminder", "kind": "commitment", "dedupeKey": "rem-1"})
    inp = EvaluateInput(user(deviceTimezone="Europe/Istanbul"), commitment, NOW)
    decision = gate.evaluate(inp)
    assert decision.allowed is True
    assert gate.commit(decision, inp) is True
    budget = PREFIX + budget_key("u1", NOW, "Europe/Istanbul")
    dedupe = PREFIX + "dedupe:u1:rem-1"
    assert gate.store.get(budget) is None
    assert gate.store.get(dedupe) == "1"


def test_malformed_hour_stats_entries_count_as_zero() -> None:
    hour = hour_of_day(NOW, None)
    candidate = Candidate.from_dict({"id": "c1", "type": "insight", "surfaces": ["push", "feed"]})
    dead_hours = [Gate.from_policy({"specVersion": "1.0.0", "checks": [{"id": "deadHours"}]}).checks[0]]
    # A missing acted count is zero, so nine dismissals alone make the hour dead and push goes.
    dismissed_only = decide(dead_hours, EvaluateInput(user(hourStats={str(hour): {"dismissed": 9}}), candidate, NOW))
    assert dismissed_only.surfaces == ("feed",)
    # An entry that is not an object counts as zero on both sides, so nothing is judged dead and push stays.
    not_an_object = decide(dead_hours, EvaluateInput(user(hourStats={str(hour): 7}), candidate, NOW))
    assert not_an_object.surfaces == ("push", "feed")


def test_a_flag_that_is_not_false_stops_nothing() -> None:
    candidate = Candidate.from_dict({"id": "c1", "type": "insight"})
    cases: list[Mapping[str, Any]] = [{"proactiveEnabled": 0}, {"proactiveEnabled": None}, {"proactiveEnabled": ""}, {}]
    for flags in cases:
        decision = decide([KillSwitchFlag("proactiveEnabled")], EvaluateInput(user(), candidate, NOW, flags))
        assert decision.allowed is True, flags


def test_the_policy_refuses_what_it_cannot_read() -> None:
    with pytest.raises(ValueError, match="onMissingTimezone"):
        Gate.from_policy({"specVersion": "1.0.0", "checks": [{"id": "quietHours", "onMissingTimezone": "skip-it"}]})
    with pytest.raises(ValueError, match="not both"):
        Gate.from_policy({"specVersion": "1.0.0", "checks": [{"id": "killSwitch", "on": True, "flag": "x"}]})
    with pytest.raises(ValueError, match="dailyLimit"):
        Gate.from_policy(nudge_policy(dailyLimit=-1))


def test_record_writes_the_hour_counter_in_the_device_zone() -> None:
    gate = Gate.from_policy({"specVersion": "1.0.0", "checks": [{"id": "consent"}]}, MemoryStore())
    person = user(deviceTimezone="Europe/Istanbul")
    candidate = Candidate.from_dict({"id": "c1", "type": "insight"})
    hour = hour_of_day(NOW, "Europe/Istanbul")
    gate.record(person, candidate, "acted", NOW)
    gate.record(person, candidate, "acted", NOW)
    gate.record(person, candidate, "dismissed", NOW)
    gate.record(person, candidate, "ignored", NOW)
    assert gate.store.get(PREFIX + hours_key("u1", hour, "acted")) == "2"
    assert gate.store.get(PREFIX + hours_key("u1", hour, "dismissed")) == "1"


class _BareStore:
    """Only the four methods the Store protocol names: no sync path, no incrBy, no eval."""

    def __init__(self) -> None:
        self.data: dict[str, str] = {}

    def get(self, key: str) -> str | None:
        return self.data.get(key)

    def set(self, key: str, value: str, ttl_seconds: int | None = None) -> None:
        self.data[key] = value

    def incr(self, key: str, ttl_seconds: int | None = None) -> int:
        value = int(self.data.get(key, "0")) + 1
        self.data[key] = str(value)
        return value

    def delete(self, key: str) -> None:
        self.data.pop(key, None)


def test_the_new_checks_need_only_the_store_protocol() -> None:
    gate = Gate.from_policy(nudge_policy(), _BareStore())
    candidate = Candidate.from_dict({"id": "c1", "type": "insight", "requested": True, "dedupeKey": "k"})
    inp = EvaluateInput(user(deviceTimezone="Europe/Istanbul"), candidate, NOW)
    decision = gate.evaluate(inp)
    assert decision.allowed is True
    assert gate.commit(decision, inp) is True


# Review round 3 (R1 to R4), fixture-free. The shared fixtures pin the common cases; these pin the edges.


def test_a_non_numeric_evidence_count_is_zero_and_refuses() -> None:
    # R2: a string, or an infinity, is not a finite count, so silence reads it as zero and refuses.
    for points in ("9", float("inf"), float("nan"), True):
        candidate = Candidate.from_dict({"id": "c1", "type": "insight", "evidence": {"dataPoints": points, "confidence": 0.9}})
        decision = decide([Silence()], EvaluateInput(user(), candidate, NOW))
        assert decision.rejected_by == "silence", points
        assert "not enough data: 0 data points" in (decision.reason or ""), points


def test_an_offset_less_instant_is_utc_whatever_the_host_zone_is() -> None:
    # R4: the instant names its own zone by being UTC; the host zone never enters it.
    assert to_datetime("2026-09-04T12:00:01") == datetime(2026, 9, 4, 12, 0, 1, tzinfo=UTC)
    assert to_datetime("2026-09-04") == datetime(2026, 9, 4, 0, 0, tzinfo=UTC)


def test_an_instant_with_an_offset_keeps_it() -> None:
    assert to_datetime("2026-09-04T12:00:01+03:00") == datetime(2026, 9, 4, 9, 0, 1, tzinfo=UTC)


def test_an_epoch_that_cannot_be_read_is_no_instant() -> None:
    # R2 and R1 family: an unreadable instant is None, which freshness treats as expired, not as a thrown error.
    for value in (1e20, float("nan"), float("inf")):
        assert to_datetime(value) is None, value


def test_an_unknown_priority_is_below_every_floor_so_quiet_hours_refuses_it() -> None:
    # The Python sibling let quietHours pass an unknown priority (a KeyError the gate fails open on), where TypeScript and Go
    # reject it. An unknown priority is below every floor.
    policy = compile_policy({"specVersion": "1.0.0", "checks": [{"id": "quietHours", "priorityFloor": "low"}]})
    user_in_quiet = UserState.from_dict({"id": "u1", "consent": True, "timezone": "UTC", "quietHours": {"start": "00:00", "end": "23:59"}})
    candidate = Candidate.from_dict({"id": "c1", "type": "insight", "priority": "urgent"})
    decision = decide(policy.checks, EvaluateInput(user_in_quiet, candidate, NOW))
    assert decision.rejected_by == "quietHours"
    assert "urgent" in (decision.reason or "")
