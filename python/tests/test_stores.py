import asyncio
from datetime import datetime, timezone
from pathlib import Path

from proactive_gate import AsyncGate, AsyncMemoryStore, Candidate, EvaluateInput, Gate, MemoryStore, SqliteStore, UserState, checks


def _exercise(store: MemoryStore | SqliteStore) -> None:
    assert store.get("a") is None
    store.set("a", "1")
    assert store.get("a") == "1"
    assert store.incr("n") == 1
    assert store.incr("n") == 2
    assert store.get("n") == "2"
    store.delete("a")
    assert store.get("a") is None


def test_memory_store() -> None:
    _exercise(MemoryStore())


def test_sqlite_store_persists_across_connections(tmp_path: Path) -> None:
    path = str(tmp_path / "gate.sqlite")
    first = SqliteStore(path)
    _exercise(first)
    first.incr("n")
    first.close()
    second = SqliteStore(path)
    assert second.get("n") == "3"
    second.close()


def _user() -> UserState:
    return UserState.from_dict({"id": "u1", "consent": True, "timezone": "Europe/Istanbul", "createdAt": "2026-01-01T00:00:00Z"})


def test_gate_commit_is_idempotent_and_budget_consumes_once() -> None:
    store = MemoryStore()
    gate = Gate([checks.Consent(), checks.DailyBudget(limit=2, near_limit=0.5)], store)
    now = datetime(2026, 9, 4, 9, 0, tzinfo=timezone.utc)
    inp = EvaluateInput(_user(), Candidate("c1", "reminder"), now)
    decision = gate.evaluate(inp)
    assert decision.allowed
    assert gate.commit(decision, inp) is True
    assert gate.commit(decision, inp) is True
    assert gate.inspect(_user(), now)["budgetUsed"] == 1
    second = gate.evaluate(EvaluateInput(_user(), Candidate("c2", "reminder"), now))
    assert second.near_limit[0].used == 1
    assert gate.commit(second, EvaluateInput(_user(), Candidate("c2", "reminder"), now)) is True
    third = gate.evaluate(EvaluateInput(_user(), Candidate("c3", "reminder"), now))
    assert third.rejected_by == "dailyBudget"
    assert third.reason == "daily budget of 2 used (2)"


def test_record_feeds_the_cooldown() -> None:
    gate = Gate([checks.DismissalCooldown(dismissals=2, within_days=30, silence_days=7)])
    now = datetime(2026, 9, 4, 9, 0, tzinfo=timezone.utc)
    for _ in range(2):
        gate.record(_user(), Candidate("c", "reminder"), "dismissed", now)
    decision = gate.evaluate(EvaluateInput(_user(), Candidate("c", "reminder"), now))
    assert decision.rejected_by == "dismissalCooldown"
    assert decision.reason is not None and decision.reason.startswith('2 dismissals of "reminder" in 30 days')
    assert gate.inspect(UserState.from_dict({"id": "u1", "consent": True, "mutedTypes": ["reminder"]}), now)["dismissals"] == {"reminder": 2}


def test_store_failure_fails_open_by_default_and_closed_on_request() -> None:
    class Broken(MemoryStore):
        def get(self, key: str) -> str | None:
            raise ConnectionError("redis down")

    now = datetime(2026, 9, 4, 9, 0, tzinfo=timezone.utc)
    inp = EvaluateInput(_user(), Candidate("c1", "reminder"), now)
    open_gate = Gate([checks.Consent(), checks.DailyBudget()], Broken())
    decision = open_gate.evaluate(inp)
    assert decision.allowed
    assert [t.outcome for t in decision.trace] == ["pass", "skip"]
    closed = Gate([checks.Consent(), checks.DailyBudget()], Broken(), on_store_error="closed").evaluate(inp)
    assert closed.rejected_by == "dailyBudget"
    assert closed.reason is not None and "fails closed" in closed.reason


def test_async_gate_shares_the_decision_logic() -> None:
    async def run() -> None:
        store = AsyncMemoryStore()
        gate = AsyncGate([checks.Consent(), checks.DailyBudget(limit=1)], store)
        now = datetime(2026, 9, 4, 9, 0, tzinfo=timezone.utc)
        inp = EvaluateInput(_user(), Candidate("c1", "reminder"), now)
        decision = await gate.evaluate(inp)
        assert decision.allowed
        assert await gate.commit(decision, inp) is True
        again = await gate.evaluate(EvaluateInput(_user(), Candidate("c2", "reminder"), now))
        assert again.rejected_by == "dailyBudget"

    asyncio.run(run())
