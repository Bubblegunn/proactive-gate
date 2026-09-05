"""proactive-gate: decide whether a proactive assistant may speak now.

The Python sibling of the TypeScript package, held to the same behaviour
contract in ``spec/`` and the same fixtures.
"""
from . import checks, presets
from .checks import Check, default_checks
from .gate import AsyncGate, Evaluation, Gate, Hooks, decide
from .policy import KNOWN_CHECKS, CompiledPolicy, compile_policy, load_policy
from .presets import Preset
from .stores import AsyncMemoryStore, AsyncStore, MemoryStore, RedisStore, SqliteStore, Store
from .types import (
    PRIORITY_RANK,
    Candidate,
    Context,
    Decision,
    EvaluateInput,
    Outcome,
    Priority,
    TraceEntry,
    UserState,
)

__version__ = "0.2.0"

__all__ = [
    "PRIORITY_RANK", "KNOWN_CHECKS", "AsyncGate", "AsyncMemoryStore", "AsyncStore", "Candidate", "Check",
    "CompiledPolicy", "Context", "Decision", "EvaluateInput", "Evaluation", "Gate", "Hooks", "MemoryStore",
    "Outcome", "Preset", "Priority", "RedisStore", "SqliteStore", "Store", "TraceEntry", "UserState",
    "__version__", "checks", "compile_policy", "decide", "default_checks", "load_policy", "presets",
]
