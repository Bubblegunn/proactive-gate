"""RedisStore: TTL attachment, with a fake client always and against a real server when one is given.

The real-server tests read PROACTIVE_GATE_REDIS_URL and skip with that reason when it is unset,
so ``pytest`` still passes with no Redis. They use their own key prefix and delete only their own
keys; nothing is flushed.
"""

import asyncio
import os
import time
from typing import Any

import pytest

from proactive_gate import RedisStore

URL = os.environ.get("PROACTIVE_GATE_REDIS_URL")
needs_server = pytest.mark.skipif(URL is None, reason="PROACTIVE_GATE_REDIS_URL is not set")


class FaultyClient:
    """In-memory stand-in. ``eval`` runs the script's two steps in one call, as Redis does for a
    script; the separate ``expire`` fails, standing in for a connection dropped between two round
    trips."""

    def __init__(self, with_eval: bool) -> None:
        self.data: dict[str, tuple[int, int]] = {}
        self.calls: list[str] = []
        self.with_eval = with_eval

    def _incr(self, key: str) -> int:
        value, ttl = self.data.get(key, (0, -1))
        self.data[key] = (value + 1, ttl)
        return value + 1

    async def incr(self, key: str) -> int:
        self.calls.append("incr")
        return self._incr(key)

    async def expire(self, key: str, seconds: int) -> None:
        self.calls.append("expire")
        raise ConnectionError("connection lost before EXPIRE")

    def __getattr__(self, name: str) -> Any:
        if name == "eval" and self.with_eval:
            async def eval_(script: str, numkeys: int, key: str, ttl: int) -> int:
                self.calls.append("eval")
                value = self._incr(key)
                if value == 1 and int(ttl) > 0:
                    self.data[key] = (value, int(ttl))
                return value
            return eval_
        raise AttributeError(name)


def test_failure_between_incr_and_expire_cannot_leave_a_counter_without_ttl() -> None:
    client = FaultyClient(with_eval=True)

    async def run() -> None:
        try:
            await RedisStore(client).incr("budget:u1", 60)
        except ConnectionError:
            pass

    asyncio.run(run())
    entry = client.data.get("budget:u1")
    assert entry is None or entry[1] > 0, f"counter left with no TTL after calls {client.calls}"
    assert client.calls == ["eval"]


def test_client_without_eval_still_works() -> None:
    class Plain:
        def __init__(self) -> None:
            self.n = 0

        async def incr(self, key: str) -> int:
            self.n += 1
            return self.n

        async def expire(self, key: str, seconds: int) -> None:
            return None

    async def run() -> list[int]:
        store = RedisStore(Plain())
        return [await store.incr("k", 60), await store.incr("k", 60)]

    assert asyncio.run(run()) == [1, 2]


async def _client() -> Any:
    from redis.asyncio import Redis

    return Redis.from_url(URL or "")


@needs_server
def test_real_server_get_set_incr_delete() -> None:
    prefix = f"pg-py:{os.getpid()}:{time.time_ns()}:"

    async def run() -> None:
        client = await _client()
        store = RedisStore(client)
        try:
            assert await store.get(prefix + "a") is None
            await store.set(prefix + "a", "1")
            assert await store.get(prefix + "a") == "1"
            await store.set(prefix + "b", "v", 60)
            assert 0 < await client.ttl(prefix + "b") <= 60
            assert await store.incr(prefix + "n", 60) == 1
            assert await store.incr(prefix + "n", 60) == 2
            assert 0 < await client.ttl(prefix + "n") <= 60
            assert await store.incr(prefix + "plain") == 1
            assert await client.ttl(prefix + "plain") == -1
            results = await asyncio.gather(*(store.incr(prefix + "c") for _ in range(100)))
            assert sorted(results) == list(range(1, 101))
            await store.delete(prefix + "a")
            assert await store.get(prefix + "a") is None
        finally:
            keys = [key async for key in client.scan_iter(match=prefix + "*")]
            if keys:
                await client.delete(*keys)
            await client.aclose()

    asyncio.run(run())


@needs_server
def test_real_server_expire_failing_after_incr_leaves_no_counter_without_ttl() -> None:
    key = f"pg-py-atomic:{os.getpid()}:{time.time_ns()}"

    class FailingExpire:
        def __init__(self, inner: Any) -> None:
            self.inner = inner

        async def expire(self, key: str, seconds: int) -> None:
            raise ConnectionError("connection lost before EXPIRE")

        def __getattr__(self, name: str) -> Any:
            return getattr(self.inner, name)

    async def run() -> int:
        client = await _client()
        try:
            try:
                await RedisStore(FailingExpire(client)).incr(key, 60)
            except ConnectionError:
                pass
            return int(await client.ttl(key))
        finally:
            await client.delete(key)
            await client.aclose()

    ttl = asyncio.run(run())
    assert ttl == -2 or ttl > 0, f"TTL is {ttl}; -1 means the counter never expires"
