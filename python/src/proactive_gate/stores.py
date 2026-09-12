"""Key-value stores. Sync ``Store`` for ``Gate``; ``AsyncStore`` for ``AsyncGate``.
Every method may raise; the gate decides whether that fails open or closed."""
from __future__ import annotations

import asyncio
import sqlite3
import threading
import time
from typing import Any, Protocol


class Store(Protocol):
    def get(self, key: str) -> str | None: ...

    def set(self, key: str, value: str, ttl_seconds: int | None = None) -> None: ...

    def incr(self, key: str, ttl_seconds: int | None = None) -> int: ...

    def delete(self, key: str) -> None: ...


class AsyncStore(Protocol):
    async def get(self, key: str) -> str | None: ...

    async def set(self, key: str, value: str, ttl_seconds: int | None = None) -> None: ...

    async def incr(self, key: str, ttl_seconds: int | None = None) -> int: ...

    async def delete(self, key: str) -> None: ...


class MemoryStore:
    """In-process store with TTLs. Good for tests and single-process deployments."""

    def __init__(self) -> None:
        self._data: dict[str, tuple[str, float | None]] = {}
        self._lock = threading.Lock()

    def _live(self, key: str) -> str | None:
        entry = self._data.get(key)
        if entry is None:
            return None
        value, expires = entry
        if expires is not None and time.time() >= expires:
            del self._data[key]
            return None
        return value

    def get(self, key: str) -> str | None:
        with self._lock:
            return self._live(key)

    def set(self, key: str, value: str, ttl_seconds: int | None = None) -> None:
        with self._lock:
            self._data[key] = (value, time.time() + ttl_seconds if ttl_seconds else None)

    def incr(self, key: str, ttl_seconds: int | None = None) -> int:
        with self._lock:
            current = self._live(key)
            next_value = int(current or 0) + 1
            expires = self._data[key][1] if current is not None else (time.time() + ttl_seconds if ttl_seconds else None)
            self._data[key] = (str(next_value), expires)
            return next_value

    def delete(self, key: str) -> None:
        with self._lock:
            self._data.pop(key, None)


class SqliteStore:
    """Standard-library sqlite3 store; one file shared by every process on the host."""

    def __init__(self, path: str = ":memory:") -> None:
        self._conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self._conn.execute("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at REAL)")
        # The partial index keeps a sweep proportional to the dead rows instead of a table scan.
        self._conn.execute("CREATE INDEX IF NOT EXISTS kv_expires_at ON kv (expires_at) WHERE expires_at IS NOT NULL")
        self._lock = threading.Lock()

    def _sweep(self, now: float) -> None:
        """A read prunes only the key it touches; a write first clears every row
        that has already expired, so a key nobody reads again does not live forever."""
        self._conn.execute("DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?", (now,))

    def _row(self, key: str) -> str | None:
        row = self._conn.execute("SELECT value, expires_at FROM kv WHERE key = ?", (key,)).fetchone()
        if row is None:
            return None
        value, expires = row
        if expires is not None and time.time() >= expires:
            self._conn.execute("DELETE FROM kv WHERE key = ?", (key,))
            return None
        return str(value)

    def get(self, key: str) -> str | None:
        with self._lock:
            return self._row(key)

    def set(self, key: str, value: str, ttl_seconds: int | None = None) -> None:
        now = time.time()
        expires = now + ttl_seconds if ttl_seconds else None
        with self._lock:
            self._sweep(now)
            self._conn.execute("INSERT OR REPLACE INTO kv (key, value, expires_at) VALUES (?, ?, ?)", (key, value, expires))

    def incr(self, key: str, ttl_seconds: int | None = None) -> int:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                self._sweep(time.time())
                current = self._row(key)
                next_value = int(current or 0) + 1
                if current is None:
                    expires = time.time() + ttl_seconds if ttl_seconds else None
                    self._conn.execute("INSERT OR REPLACE INTO kv (key, value, expires_at) VALUES (?, ?, ?)", (key, str(next_value), expires))
                else:
                    self._conn.execute("UPDATE kv SET value = ? WHERE key = ?", (str(next_value), key))
                self._conn.execute("COMMIT")
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
            return next_value

    def delete(self, key: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM kv WHERE key = ?", (key,))

    def close(self) -> None:
        self._conn.close()


class AsyncMemoryStore:
    """``MemoryStore`` behind the async protocol, for ``AsyncGate`` tests."""

    def __init__(self, inner: MemoryStore | None = None) -> None:
        self.inner = inner or MemoryStore()

    async def get(self, key: str) -> str | None:
        return self.inner.get(key)

    async def set(self, key: str, value: str, ttl_seconds: int | None = None) -> None:
        self.inner.set(key, value, ttl_seconds)

    async def incr(self, key: str, ttl_seconds: int | None = None) -> int:
        return self.inner.incr(key, ttl_seconds)

    async def delete(self, key: str) -> None:
        self.inner.delete(key)


class AsyncSqliteStore:
    """``SqliteStore`` behind the async protocol: the same file, schema and expiry rules,
    over ``aiosqlite`` so the event loop never blocks. The driver is the optional
    ``aiosqlite`` extra, imported in the constructor so importing the package without it
    still works. Unlike ``SqliteStore`` the schema is created on first use, not at
    construction, so a store that is never awaited starts no thread and creates no file."""

    def __init__(self, path: str = ":memory:") -> None:
        import aiosqlite

        self._conn: aiosqlite.Connection = aiosqlite.connect(path, isolation_level=None)
        self._opened = False
        self._lock = asyncio.Lock()

    async def _open(self) -> None:
        """The connection's worker thread starts on first use: awaiting it is allowed
        exactly once, so construction stays synchronous and a store that is never
        awaited starts nothing. Always called with ``self._lock`` held."""
        if self._opened:
            return
        await self._conn
        await self._conn.execute("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at REAL)")
        # The partial index keeps a sweep proportional to the dead rows instead of a table scan.
        await self._conn.execute("CREATE INDEX IF NOT EXISTS kv_expires_at ON kv (expires_at) WHERE expires_at IS NOT NULL")
        self._opened = True

    async def _sweep(self, now: float) -> None:
        """A read prunes only the key it touches; a write first clears every row
        that has already expired, so a key nobody reads again does not live forever."""
        await self._conn.execute("DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?", (now,))

    async def _row(self, key: str) -> str | None:
        async with await self._conn.execute("SELECT value, expires_at FROM kv WHERE key = ?", (key,)) as cursor:
            row = await cursor.fetchone()
        if row is None:
            return None
        value, expires = row
        if expires is not None and time.time() >= expires:
            await self._conn.execute("DELETE FROM kv WHERE key = ?", (key,))
            return None
        return str(value)

    async def get(self, key: str) -> str | None:
        async with self._lock:
            await self._open()
            return await self._row(key)

    async def set(self, key: str, value: str, ttl_seconds: int | None = None) -> None:
        now = time.time()
        expires = now + ttl_seconds if ttl_seconds else None
        async with self._lock:
            await self._open()
            await self._sweep(now)
            await self._conn.execute("INSERT OR REPLACE INTO kv (key, value, expires_at) VALUES (?, ?, ?)", (key, value, expires))

    async def incr(self, key: str, ttl_seconds: int | None = None) -> int:
        async with self._lock:
            await self._open()
            await self._conn.execute("BEGIN IMMEDIATE")
            try:
                await self._sweep(time.time())
                current = await self._row(key)
                next_value = int(current or 0) + 1
                if current is None:
                    expires = time.time() + ttl_seconds if ttl_seconds else None
                    await self._conn.execute("INSERT OR REPLACE INTO kv (key, value, expires_at) VALUES (?, ?, ?)", (key, str(next_value), expires))
                else:
                    await self._conn.execute("UPDATE kv SET value = ? WHERE key = ?", (str(next_value), key))
                await self._conn.execute("COMMIT")
            except BaseException:
                await self._conn.execute("ROLLBACK")
                raise
            return next_value

    async def delete(self, key: str) -> None:
        async with self._lock:
            await self._open()
            await self._conn.execute("DELETE FROM kv WHERE key = ?", (key,))

    async def close(self) -> None:
        async with self._lock:
            await self._conn.close()


class RedisStore:
    """Wraps a ``redis.asyncio`` client. INCR, then EXPIRE on the first increment so a key never lives forever."""

    def __init__(self, client: Any) -> None:
        self.client = client

    async def get(self, key: str) -> str | None:
        value = await self.client.get(key)
        if value is None:
            return None
        return value.decode() if isinstance(value, bytes) else str(value)

    async def set(self, key: str, value: str, ttl_seconds: int | None = None) -> None:
        if ttl_seconds:
            await self.client.set(key, value, ex=ttl_seconds)
        else:
            await self.client.set(key, value)

    async def incr(self, key: str, ttl_seconds: int | None = None) -> int:
        value = int(await self.client.incr(key))
        if value == 1 and ttl_seconds:
            await self.client.expire(key, ttl_seconds)
        return value

    async def delete(self, key: str) -> None:
        await self.client.delete(key)


__all__ = ["AsyncMemoryStore", "AsyncSqliteStore", "AsyncStore", "MemoryStore", "RedisStore", "SqliteStore", "Store"]
