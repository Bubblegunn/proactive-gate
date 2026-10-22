"""Decision ids are unique per gate, so two gates sharing one store never share an id, including a gate forked after it was built."""
from __future__ import annotations

import os
from datetime import UTC, datetime

import pytest

from proactive_gate import Candidate, EvaluateInput, Gate, MemoryStore, UserState
from proactive_gate.checks import DailyBudget
from proactive_gate.types import iso_z

NOW = datetime(2026, 9, 4, 9, 0, tzinfo=UTC)
USER = UserState(id="u1", consent=True, timezone="Europe/Istanbul")
CANDIDATE = Candidate(id="c1", type="reminder")


def _input() -> EvaluateInput:
    return EvaluateInput(USER, CANDIDATE, NOW)


def _parts(decision_id: str) -> tuple[str, str, str]:
    """The prefix, the token and the sequence of a decision id."""
    prefix, _, rest = decision_id.partition("#")
    token, _, sequence = rest.rpartition("-")
    return prefix, token, sequence


def test_two_gates_in_one_process_never_share_a_token() -> None:
    first = Gate([DailyBudget(limit=5)], store=MemoryStore()).evaluate(_input())
    second = Gate([DailyBudget(limit=5)], store=MemoryStore()).evaluate(_input())
    assert _parts(first.id)[1] != _parts(second.id)[1]
    assert first.id != second.id


def test_one_gate_keeps_its_token_and_counts_its_sequence() -> None:
    gate = Gate([DailyBudget(limit=5)], store=MemoryStore())
    first = gate.evaluate(_input())
    second = gate.evaluate(_input())
    prefix, token, sequence = _parts(first.id)
    assert prefix == f"{USER.id}:{CANDIDATE.id}:{iso_z(NOW)}"
    assert sequence.isdigit()
    assert _parts(second.id)[1] == token
    assert int(_parts(second.id)[2]) == int(sequence) + 1


def test_two_gates_sharing_one_store_each_spend_a_unit() -> None:
    store = MemoryStore()
    first = Gate([DailyBudget(limit=5)], store=store)
    second = Gate([DailyBudget(limit=5)], store=store)
    one = first.evaluate(_input())
    two = second.evaluate(_input())
    assert one.id != two.id
    assert first.commit(one, _input()) is True
    assert second.commit(two, _input()) is True
    assert first.inspect(USER, NOW)["budgetUsed"] == 2


@pytest.mark.skipif(not hasattr(os, "fork"), reason="this platform has no os.fork")
def test_a_gate_built_before_fork_gets_a_new_token_in_the_child() -> None:
    gate = Gate([DailyBudget(limit=5)], store=MemoryStore())
    parent_id = gate.evaluate(_input()).id
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:
        try:
            os.close(read_fd)
            child_id = gate.evaluate(_input()).id
            os.write(write_fd, child_id.encode())
            os.close(write_fd)
        finally:
            os._exit(0)
    os.close(write_fd)
    chunks = []
    while chunk := os.read(read_fd, 4096):
        chunks.append(chunk)
    os.close(read_fd)
    _, status = os.waitpid(pid, 0)
    assert os.waitstatus_to_exitcode(status) == 0
    child_id = b"".join(chunks).decode()
    assert child_id != parent_id
    assert _parts(child_id)[1] != _parts(parent_id)[1]
    assert _parts(child_id)[2] == "1"
