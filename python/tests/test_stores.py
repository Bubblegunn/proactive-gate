import asyncio
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest

from proactive_gate import AsyncGate, AsyncMemoryStore, AsyncSqliteStore, AsyncStore, Candidate, EvaluateInput, Gate, MemoryStore, SqliteStore, UserState, checks


def _exercise(store: MemoryStore | SqliteStore) -> None:
    assert store.get("a") is None
    store.set("a", "1")
    assert store.get("a") == "1"
    assert store.incr("n") == 1
    assert store.incr("n") == 2
    assert store.get("n") == "2"
    store.delete("a")
    assert store.get("a") is None


async def _exercise_async(store: AsyncStore) -> None:
    assert await store.get("a") is None
    await store.set("a", "1")
    assert await store.get("a") == "1"
    assert await store.incr("n") == 1
    assert await store.incr("n") == 2
    assert await store.get("n") == "2"
    await store.delete("a")
    assert await store.get("a") is None


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


def test_sqlite_store_removes_expired_rows_on_write(tmp_path: Path) -> None:
    path = str(tmp_path / "gate.sqlite")
    store = SqliteStore(path)
    raw = sqlite3.connect(path, isolation_level=None)
    expired = time.time() - 10
    for i in range(50):
        raw.execute("INSERT INTO kv (key, value, expires_at) VALUES (?, 'v', ?)", (f"stale-{i}", expired))
    raw.execute("INSERT INTO kv (key, value, expires_at) VALUES ('keeper', 'v', ?)", (time.time() + 600,))
    # None of the stale keys were read, so all fifty rows are still physically there.
    assert raw.execute("SELECT COUNT(*) FROM kv").fetchone()[0] == 51
    store.incr("fresh", 60)
    assert {key for (key,) in raw.execute("SELECT key FROM kv")} == {"keeper", "fresh"}
    raw.close()
    store.close()


def test_sqlite_store_sweeps_on_set_too(tmp_path: Path) -> None:
    """Mutating set() to skip the sweep left every suite green: only incr was asserted."""
    path = str(tmp_path / "gate.sqlite")
    store = SqliteStore(path)
    raw = sqlite3.connect(path, isolation_level=None)
    expired = time.time() - 10
    for i in range(50):
        raw.execute("INSERT INTO kv (key, value, expires_at) VALUES (?, 'v', ?)", (f"stale-{i}", expired))
    raw.execute("INSERT INTO kv (key, value, expires_at) VALUES ('keeper', 'v', ?)", (time.time() + 600,))
    assert raw.execute("SELECT COUNT(*) FROM kv").fetchone()[0] == 51
    store.set("fresh", "v", 60)
    assert {key for (key,) in raw.execute("SELECT key FROM kv")} == {"keeper", "fresh"}
    raw.close()
    store.close()


def test_async_sqlite_store_sweeps_on_set_too(tmp_path: Path) -> None:
    pytest.importorskip("aiosqlite")

    async def run() -> None:
        path = str(tmp_path / "async.sqlite")
        store = AsyncSqliteStore(path)
        raw = sqlite3.connect(path, isolation_level=None)
        try:
            raw.execute("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at REAL)")
            expired = time.time() - 10
            for i in range(50):
                raw.execute("INSERT INTO kv (key, value, expires_at) VALUES (?, 'v', ?)", (f"stale-{i}", expired))
            raw.execute("INSERT INTO kv (key, value, expires_at) VALUES ('keeper', 'v', ?)", (time.time() + 600,))
            assert raw.execute("SELECT COUNT(*) FROM kv").fetchone()[0] == 51
            await store.set("fresh", "v", 60)
            assert {key for (key,) in raw.execute("SELECT key FROM kv")} == {"keeper", "fresh"}
        finally:
            raw.close()
            await store.close()

    asyncio.run(run())


def test_async_memory_store() -> None:
    asyncio.run(_exercise_async(AsyncMemoryStore()))


def test_async_sqlite_store() -> None:
    pytest.importorskip("aiosqlite")
    async def run() -> None:
        store = AsyncSqliteStore()
        try:
            await _exercise_async(store)
        finally:
            await store.close()

    asyncio.run(run())


def test_async_sqlite_store_persists_across_connections(tmp_path: Path) -> None:
    pytest.importorskip("aiosqlite")
    async def run() -> None:
        path = str(tmp_path / "gate.sqlite")
        first = AsyncSqliteStore(path)
        try:
            await _exercise_async(first)
            await first.incr("n")
        finally:
            await first.close()
        second = AsyncSqliteStore(path)
        try:
            assert await second.get("n") == "3"
        finally:
            await second.close()

    asyncio.run(run())


def test_async_sqlite_store_removes_expired_rows_on_write(tmp_path: Path) -> None:
    pytest.importorskip("aiosqlite")
    async def run() -> None:
        path = str(tmp_path / "gate.sqlite")
        store = AsyncSqliteStore(path)
        raw = sqlite3.connect(path, isolation_level=None)
        try:
            raw.execute("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at REAL)")
            expired = time.time() - 10
            for i in range(50):
                raw.execute("INSERT INTO kv (key, value, expires_at) VALUES (?, 'v', ?)", (f"stale-{i}", expired))
            raw.execute("INSERT INTO kv (key, value, expires_at) VALUES ('keeper', 'v', ?)", (time.time() + 600,))
            # None of the stale keys were read, so all fifty rows are still physically there.
            assert raw.execute("SELECT COUNT(*) FROM kv").fetchone()[0] == 51
            await store.incr("fresh", 60)
            assert {key for (key,) in raw.execute("SELECT key FROM kv")} == {"keeper", "fresh"}
        finally:
            raw.close()
            await store.close()

    asyncio.run(run())


def test_async_sqlite_store_read_removes_only_the_expired_row_it_touched(tmp_path: Path) -> None:
    pytest.importorskip("aiosqlite")
    async def run() -> None:
        path = str(tmp_path / "gate.sqlite")
        raw = sqlite3.connect(path, isolation_level=None)
        store = AsyncSqliteStore(path)
        try:
            raw.execute("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at REAL)")
            expired = time.time() - 10
            raw.execute("INSERT INTO kv (key, value, expires_at) VALUES ('old', 'v', ?)", (expired,))
            raw.execute("INSERT INTO kv (key, value, expires_at) VALUES ('stale', 'v', ?)", (expired,))
            raw.execute("INSERT INTO kv (key, value, expires_at) VALUES ('new', 'v', ?)", (time.time() + 600,))
            assert await store.get("old") is None
            # The read pruned the row it touched; the other stale row waits for a sweep.
            assert {key for (key,) in raw.execute("SELECT key FROM kv")} == {"stale", "new"}
            assert await store.get("new") == "v"
        finally:
            raw.close()
            await store.close()

    asyncio.run(run())


def test_async_sqlite_store_matches_the_sync_store_operation_by_operation(tmp_path: Path) -> None:
    """The two stores are one behaviour with two call styles, so the same sequence must give the same answers.

    Written because the review of #32 measured this by hand and a number measured by hand is a
    number nobody else can repeat.
    """
    pytest.importorskip("aiosqlite")

    async def run() -> None:
        sync = SqliteStore(str(tmp_path / "sync.sqlite"))
        store = AsyncSqliteStore(str(tmp_path / "async.sqlite"))
        try:
            steps: list[tuple[str, str]] = [
                ("get", "missing"), ("set", "k"), ("get", "k"), ("incr", "n"), ("incr", "n"),
                ("get", "n"), ("set", "ttl"), ("get", "ttl"), ("delete", "k"), ("get", "k"),
                ("incr", "ttl2"), ("get", "ttl2"), ("delete", "nothing"),
            ]
            for op, key in steps:
                if op == "get":
                    assert sync.get(key) == await store.get(key), f"get {key}"
                elif op == "set":
                    sync.set(key, "v")
                    await store.set(key, "v")
                elif op == "incr":
                    assert sync.incr(key) == await store.incr(key), f"incr {key}"
                else:
                    sync.delete(key)
                    await store.delete(key)
            # A zero TTL means no expiry in both, and an elapsed one is invisible to both.
            sync.set("zero", "v", 0)
            await store.set("zero", "v", 0)
            assert sync.get("zero") == await store.get("zero") == "v"
        finally:
            sync.close()
            await store.close()

    asyncio.run(run())


def test_async_sqlite_store_leaves_the_event_loop_free(tmp_path: Path) -> None:
    """Liveness, not a benchmark: a concurrent task must still get turns while the store writes.

    The count is deliberately not asserted. Four runs of the same probe during review gave 23, 56,
    45 and 78 ticks, so any figure here would be a number nobody can reproduce; that it is above
    zero is the claim, and a blocking driver would give exactly zero.
    """
    pytest.importorskip("aiosqlite")

    async def run() -> None:
        store = AsyncSqliteStore(str(tmp_path / "loop.sqlite"))
        ticks = 0

        async def ticker() -> None:
            nonlocal ticks
            while True:
                await asyncio.sleep(0.001)
                ticks += 1

        task = asyncio.create_task(ticker())
        try:
            for i in range(400):
                await store.set(f"k{i}", "v")
        finally:
            task.cancel()
            await store.close()
        assert ticks > 0, "the event loop never got a turn while the store was writing"

    asyncio.run(run())


def test_async_sqlite_store_incr_is_atomic_across_tasks(tmp_path: Path) -> None:
    pytest.importorskip("aiosqlite")
    async def run() -> None:
        store = AsyncSqliteStore(str(tmp_path / "gate.sqlite"))
        try:
            results = await asyncio.gather(*(store.incr("n") for _ in range(20)))
            assert sorted(results) == list(range(1, 21))
            assert await store.get("n") == "20"
        finally:
            await store.close()

    asyncio.run(run())


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


def test_async_gate_over_async_sqlite_store(tmp_path: Path) -> None:
    pytest.importorskip("aiosqlite")
    async def run() -> None:
        store = AsyncSqliteStore(str(tmp_path / "gate.sqlite"))
        try:
            gate = AsyncGate([checks.Consent(), checks.DailyBudget(limit=1)], store)
            now = datetime(2026, 9, 4, 9, 0, tzinfo=timezone.utc)
            inp = EvaluateInput(_user(), Candidate("c1", "reminder"), now)
            decision = await gate.evaluate(inp)
            assert decision.allowed
            assert await gate.commit(decision, inp) is True
            again = await gate.evaluate(EvaluateInput(_user(), Candidate("c2", "reminder"), now))
            assert again.rejected_by == "dailyBudget"
        finally:
            await store.close()

    asyncio.run(run())


def test_async_sqlite_store_incr_does_not_extend_an_existing_ttl(tmp_path: Path) -> None:
    pytest.importorskip("aiosqlite")

    async def run() -> None:
        path = str(tmp_path / "gate.sqlite")
        store = AsyncSqliteStore(path)
        raw = sqlite3.connect(path, isolation_level=None)
        try:
            assert await store.incr("n", 60) == 1
            first = raw.execute("SELECT expires_at FROM kv WHERE key = 'n'").fetchone()[0]
            await asyncio.sleep(0.05)
            assert await store.incr("n", 60) == 2
            assert raw.execute("SELECT expires_at FROM kv WHERE key = 'n'").fetchone()[0] == first
        finally:
            raw.close()
            await store.close()

    asyncio.run(run())
