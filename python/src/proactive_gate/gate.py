"""The decision loop exists once, as a sans-IO ``Evaluation``. ``Gate`` and
``AsyncGate`` only fetch keys and feed values; every rule about ordering,
shadow mode, deferral, hooks and idempotent commit lives here."""
from __future__ import annotations

import json
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from .checks import Budget, Check, OnlyWhen, budget_key, dismissal_key
from .clock import DAY_SECONDS
from .stores import AsyncStore, MemoryStore, Store
from .types import (
    UTC,
    Candidate,
    ConsumePlan,
    Context,
    Decision,
    EvaluateInput,
    NearLimitNote,
    Outcome,
    OutcomeEvent,
    StoreErrorMode,
    TraceEntry,
    UserState,
    epoch_ms,
    iso_z,
    surfaces_for,
)

COMMIT_TTL = 2 * DAY_SECONDS
Values = Mapping[str, str | None]


@dataclass(slots=True)
class Hooks:
    """Observation points. Hooks never change a decision; a raising hook is reported to ``error`` and ignored."""

    before: Callable[[Context, Check], None] | None = None
    after: Callable[[Context, Check, Outcome, float], None] | None = None
    error: Callable[[Context, Check, BaseException], None] | None = None
    finally_: Callable[[Decision], None] | None = None


_sequence = 0


def _next_sequence() -> int:
    global _sequence
    _sequence += 1
    return _sequence


@dataclass(slots=True)
class Evaluation:
    """Pure state machine: ask ``pending()`` which check is next, fetch ``keys()``, ``feed()`` the values, repeat."""

    checks: Sequence[Check]
    input: EvaluateInput
    on_store_error: StoreErrorMode = "open"
    hooks: Hooks = field(default_factory=Hooks)
    now: datetime = field(init=False)
    _index: int = 0
    _trace: list[TraceEntry] = field(default_factory=list)
    _shadowed: list[str] = field(default_factory=list)
    _near: list[NearLimitNote] = field(default_factory=list)
    _surfaces: tuple[str, ...] = ()
    _deliver_at: datetime | None = None
    _result: Decision | None = None

    def __post_init__(self) -> None:
        self.now = self.input.now or datetime.now(UTC)
        self._surfaces = surfaces_for(self.input.user, self.input.candidate)

    def context(self) -> Context:
        return Context(self.input.user, self.input.candidate, self.now, self.input.candidate.priority, self._surfaces)

    def pending(self) -> Check | None:
        if self._result is not None or self._index >= len(self.checks):
            return None
        return self.checks[self._index]

    def keys(self) -> Sequence[str]:
        check = self.pending()
        return check.keys(self.context()) if check else ()

    def _call(self, name: str, *args: Any) -> None:
        hook = getattr(self.hooks, name)
        if hook is None:
            return
        try:
            hook(*args)
        except BaseException as error:  # noqa: BLE001 - hooks must never break a decision
            if name != "error" and self.hooks.error is not None and len(args) >= 2:
                try:
                    self.hooks.error(args[0], args[1], error)
                except BaseException:  # noqa: BLE001
                    pass

    def feed(self, values: Values | None, error: BaseException | None = None) -> None:
        check = self.pending()
        if check is None:
            raise RuntimeError("nothing pending")
        ctx = self.context()
        self._index += 1
        self._call("before", ctx, check)
        started = time.perf_counter()
        outcome: Outcome
        if error is None:
            try:
                outcome = check.run(ctx, values or {})
            except BaseException as raised:  # noqa: BLE001 - a check failure is a trace entry, not a crash
                error = raised
        if error is not None:
            message = str(error) or error.__class__.__name__
            self._call("error", ctx, check, error)
            ms = _elapsed(started)
            if self.on_store_error == "closed":
                self._trace.append(TraceEntry(check.id, "reject", ms, f"check threw ({message}); failing closed"))
                self._finish(rejected_by=check.id, reason=f'check "{check.id}" failed and the gate fails closed: {message}')
                return
            self._trace.append(TraceEntry(check.id, "skip", ms, f"check threw ({message}); failing open"))
            self._maybe_finish()
            return
        ms = _elapsed(started)
        self._call("after", ctx, check, outcome, ms)
        if check.non_rejecting and outcome.kind in ("reject", "defer"):
            self._trace.append(TraceEntry(check.id, "skip", ms, f"non-rejecting check returned {outcome.kind} ({outcome.reason}); ignored"))
            self._maybe_finish()
            return
        stops = outcome.kind in ("reject", "defer")
        self._trace.append(TraceEntry(check.id, outcome.kind, ms, outcome.reason or None, shadow=bool(stops and check.shadow)))
        if outcome.kind == "pass" and outcome.near_limit is not None:
            self._near.append(NearLimitNote(check.id, outcome.near_limit.used, outcome.near_limit.limit))
        if stops and check.shadow:
            self._shadowed.append(check.id)
            self._maybe_finish()
            return
        if outcome.kind == "reject":
            self._finish(rejected_by=check.id, reason=outcome.reason)
            return
        if outcome.kind == "defer":
            self._finish(deferred_by=check.id, retry_at=outcome.retry_at, reason=outcome.reason)
            return
        if outcome.kind == "adjust":
            if outcome.deliver_at is not None:
                self._deliver_at = outcome.deliver_at
            if outcome.surfaces is not None:
                self._surfaces = tuple(outcome.surfaces)
        self._maybe_finish()

    def _maybe_finish(self) -> None:
        if self._index >= len(self.checks):
            self._finish(allowed=True)

    def _finish(
        self,
        allowed: bool = False,
        rejected_by: str | None = None,
        deferred_by: str | None = None,
        retry_at: datetime | None = None,
        reason: str | None = None,
    ) -> None:
        user, candidate = self.input.user, self.input.candidate
        self._result = Decision(
            id=f"{user.id}:{candidate.id}:{iso_z(self.now)}#{_next_sequence()}",
            allowed=allowed,
            user_id=user.id,
            candidate_id=candidate.id,
            surfaces=self._surfaces if allowed else (),
            trace=tuple(self._trace),
            evaluated_at=self.now,
            shadowed=tuple(self._shadowed),
            near_limit=tuple(self._near),
            deliver_at=self._deliver_at if allowed else None,
            rejected_by=rejected_by,
            deferred_by=deferred_by,
            retry_at=retry_at,
            reason=reason,
        )
        self._call("finally_", self._result)

    def decision(self) -> Decision:
        if self._result is None:
            raise RuntimeError("evaluation has not finished")
        return self._result


def decide(checks: Sequence[Check], input: EvaluateInput, values: Mapping[str, Values] | None = None, hooks: Hooks | None = None, on_store_error: StoreErrorMode = "open") -> Decision:
    """Pure decision from precomputed values, keyed by check id. No store, no clock beyond ``input.now``."""
    ev = Evaluation(checks, input, on_store_error, hooks or Hooks())
    while (check := ev.pending()) is not None:
        ev.feed((values or {}).get(check.id, {}))
    return ev.decision()


def _elapsed(started: float) -> float:
    return round((time.perf_counter() - started) * 1000, 3)


def _consumers(checks: Iterable[Check]) -> list[Check]:
    """Any check that offers a commit-time plan. Duck-typed, as the TypeScript side is:
    a new consumer must not have to be added to a class list to be honoured."""
    return [c for c in checks if hasattr(c, "consume_plan")]


def _plan(check: Check, ctx: Context) -> ConsumePlan | None:
    plan = getattr(check, "consume_plan")(ctx)
    return plan if isinstance(plan, ConsumePlan) else None


class _Prefixed:
    def __init__(self, prefix: str) -> None:
        self.prefix = prefix

    def key(self, key: str) -> str:
        return self.prefix + key


class Gate:
    """Synchronous gate over a ``Store``."""

    def __init__(
        self,
        checks: Sequence[Check],
        store: Store | None = None,
        on_store_error: StoreErrorMode = "open",
        key_prefix: str = "pg:",
        on_decision: Callable[[Decision], None] | None = None,
        hooks: Hooks | None = None,
    ) -> None:
        self.checks: tuple[Check, ...] = tuple(checks)
        self.store: Store = store if store is not None else MemoryStore()
        self.on_store_error: StoreErrorMode = on_store_error
        self._p = _Prefixed(key_prefix)
        self.on_decision = on_decision
        self.hooks = hooks or Hooks()
        self._consumers = _consumers(self.checks)

    @classmethod
    def from_policy(cls, policy: Mapping[str, Any], store: Store | None = None, on_decision: Callable[[Decision], None] | None = None, hooks: Hooks | None = None) -> "Gate":
        from .policy import compile_policy

        compiled = compile_policy(policy)
        return cls(compiled.checks, store, compiled.on_store_error, compiled.key_prefix, on_decision, hooks)

    def evaluate(self, input: EvaluateInput) -> Decision:
        ev = Evaluation(self.checks, input, self.on_store_error, self.hooks)
        while ev.pending() is not None:
            try:
                values = {k: self.store.get(self._p.key(k)) for k in ev.keys()}
            except Exception as error:  # noqa: BLE001 - a store failure is a trace entry
                ev.feed(None, error)
                continue
            ev.feed(values)
        decision = ev.decision()
        if self.on_decision:
            self.on_decision(decision)
        return decision

    def commit(self, decision: Decision, input: EvaluateInput) -> bool:
        if not decision.allowed:
            return False
        if not self._consumers:
            return True
        now = input.now or decision.evaluated_at
        marker = self._p.key(f"commit:{decision.id}")
        try:
            seen = self.store.get(marker)
            if seen is not None:
                return seen == "1"
            ok = True
            ctx = Context(input.user, input.candidate, now, input.candidate.priority, decision.surfaces)
            for check in self._consumers:
                plan = _plan(check, ctx)
                if plan is None:
                    continue
                if self.store.incr(self._p.key(plan.key), plan.ttl_seconds) > plan.limit:
                    ok = False
                    break
            self.store.set(marker, "1" if ok else "0", COMMIT_TTL)
            return ok
        except Exception:  # noqa: BLE001
            return self.on_store_error == "open"

    def record(self, user: UserState, candidate: Candidate, event: OutcomeEvent, at: datetime | None = None) -> None:
        if event != "dismissed":
            return
        at = at or datetime.now(UTC)
        key = self._p.key(dismissal_key(user.id, candidate.type))
        raw = self.store.get(key)
        stamps: list[int] = json.loads(raw) if raw else []
        keep_from = epoch_ms(at) - 90 * DAY_SECONDS * 1000
        stamps = [t for t in stamps if t >= keep_from] + [epoch_ms(at)]
        self.store.set(key, json.dumps(stamps, separators=(",", ":")), 90 * DAY_SECONDS)

    def inspect(self, user: UserState, now: datetime | None = None) -> dict[str, Any]:
        now = now or datetime.now(UTC)
        used = int(self.store.get(self._p.key(budget_key(user.id, now, user.timezone))) or 0)
        dismissals: dict[str, int] = {}
        for type_ in user.muted_types:
            raw = self.store.get(self._p.key(dismissal_key(user.id, type_)))
            dismissals[type_] = len(json.loads(raw)) if raw else 0
        return {"budgetUsed": used, "dismissals": dismissals}


class AsyncGate:
    """The same gate over an ``AsyncStore``; the decision logic is the shared ``Evaluation``."""

    def __init__(
        self,
        checks: Sequence[Check],
        store: AsyncStore,
        on_store_error: StoreErrorMode = "open",
        key_prefix: str = "pg:",
        on_decision: Callable[[Decision], None] | None = None,
        hooks: Hooks | None = None,
    ) -> None:
        self.checks: tuple[Check, ...] = tuple(checks)
        self.store = store
        self.on_store_error: StoreErrorMode = on_store_error
        self._p = _Prefixed(key_prefix)
        self.on_decision = on_decision
        self.hooks = hooks or Hooks()
        self._consumers = _consumers(self.checks)

    @classmethod
    def from_policy(cls, policy: Mapping[str, Any], store: AsyncStore, on_decision: Callable[[Decision], None] | None = None, hooks: Hooks | None = None) -> "AsyncGate":
        from .policy import compile_policy

        compiled = compile_policy(policy)
        return cls(compiled.checks, store, compiled.on_store_error, compiled.key_prefix, on_decision, hooks)

    async def evaluate(self, input: EvaluateInput) -> Decision:
        ev = Evaluation(self.checks, input, self.on_store_error, self.hooks)
        while ev.pending() is not None:
            try:
                values = {k: await self.store.get(self._p.key(k)) for k in ev.keys()}
            except Exception as error:  # noqa: BLE001
                ev.feed(None, error)
                continue
            ev.feed(values)
        decision = ev.decision()
        if self.on_decision:
            self.on_decision(decision)
        return decision

    async def commit(self, decision: Decision, input: EvaluateInput) -> bool:
        if not decision.allowed:
            return False
        if not self._consumers:
            return True
        now = input.now or decision.evaluated_at
        marker = self._p.key(f"commit:{decision.id}")
        try:
            seen = await self.store.get(marker)
            if seen is not None:
                return seen == "1"
            ok = True
            ctx = Context(input.user, input.candidate, now, input.candidate.priority, decision.surfaces)
            for check in self._consumers:
                plan = _plan(check, ctx)
                if plan is None:
                    continue
                if await self.store.incr(self._p.key(plan.key), plan.ttl_seconds) > plan.limit:
                    ok = False
                    break
            await self.store.set(marker, "1" if ok else "0", COMMIT_TTL)
            return ok
        except Exception:  # noqa: BLE001
            return self.on_store_error == "open"

    async def record(self, user: UserState, candidate: Candidate, event: OutcomeEvent, at: datetime | None = None) -> None:
        if event != "dismissed":
            return
        at = at or datetime.now(UTC)
        key = self._p.key(dismissal_key(user.id, candidate.type))
        raw = await self.store.get(key)
        stamps: list[int] = json.loads(raw) if raw else []
        keep_from = epoch_ms(at) - 90 * DAY_SECONDS * 1000
        stamps = [t for t in stamps if t >= keep_from] + [epoch_ms(at)]
        await self.store.set(key, json.dumps(stamps, separators=(",", ":")), 90 * DAY_SECONDS)

    async def inspect(self, user: UserState, now: datetime | None = None) -> dict[str, Any]:
        now = now or datetime.now(UTC)
        used = int(await self.store.get(self._p.key(budget_key(user.id, now, user.timezone))) or 0)
        dismissals: dict[str, int] = {}
        for type_ in user.muted_types:
            raw = await self.store.get(self._p.key(dismissal_key(user.id, type_)))
            dismissals[type_] = len(json.loads(raw)) if raw else 0
        return {"budgetUsed": used, "dismissals": dismissals}


__all__ = ["AsyncGate", "Evaluation", "Gate", "Hooks", "decide"]
