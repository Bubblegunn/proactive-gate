"""JSON policies (spec/schema/policy.schema.json) compiled into checks."""
from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from . import checks as c
from .checks import Check
from .presets import presets
from .types import StoreErrorMode

Options = Mapping[str, Any]
Factory = Callable[[Options], Check]

SUPPORTED_MAJOR = 1


def _budget(cls: type[c.Budget]) -> Factory:
    return lambda o: cls(limit=o.get("limit"), bypass_priority=o.get("bypassPriority"), near_limit=o.get("nearLimit", 0.8))


KNOWN_CHECKS: dict[str, Factory] = {
    "killSwitch": lambda o: c.KillSwitch(bool(o.get("on", False))),
    "consent": lambda o: c.Consent(),
    "enabled": lambda o: c.Enabled(),
    "mode": lambda o: c.Mode(o.get("allow", ["normal"])),
    "snooze": lambda o: c.Snooze(defer=bool(o.get("defer", False))),
    "mute": lambda o: c.Mute(),
    "intensity": lambda o: c.Intensity(o.get("floors")),
    "quietHours": lambda o: c.QuietHours(o.get("priorityFloor", "critical")),
    "trustRamp": lambda o: c.TrustRamp(o.get("days", 7), o.get("minPriority", "high")),
    "dismissalCooldown": lambda o: c.DismissalCooldown(o.get("dismissals", 3), o.get("withinDays", 30), o.get("silenceDays", 7)),
    "adaptiveTiming": lambda o: c.AdaptiveTiming(),
    "dailyBudget": _budget(c.DailyBudget),
    "weeklyBudget": _budget(c.WeeklyBudget),
    "monthlyBudget": _budget(c.MonthlyBudget),
    "utilityFloor": lambda o: c.UtilityFloor(o.get("costFalseAlarm", 1), o.get("costMissedHelp", 1)),
    "boundedDeferral": lambda o: c.BoundedDeferral(o.get("lambda", 1 / 43), o.get("interruptCost", 1), o.get("staleness", 0.0001), o.get("boundSeconds", 240)),
    "allowedWindow": lambda o: c.AllowedWindow(o.get("start", "08:00"), o.get("end", "21:00"), o.get("timezone", "user"), o.get("priorityFloor"), o.get("id", "allowedWindow")),
    "requiresConsent": lambda o: c.RequiresConsent(o.get("name", "consent"), o.get("when"), o.get("id")),
    "rateLimit": lambda o: c.RateLimit(o.get("limit", 1), o.get("perSeconds", 1), o.get("keyBy", "user"), o.get("id")),
    "recentInteraction": lambda o: c.RecentInteraction(o.get("withinHours", 48)),
    "windowBudget": lambda o: c.WindowBudget(o.get("limit", 1), o.get("withinHours", 48)),
}


@dataclass(frozen=True, slots=True)
class CompiledPolicy:
    checks: tuple[Check, ...]
    on_store_error: StoreErrorMode
    key_prefix: str


def compile_policy(policy: Mapping[str, Any]) -> CompiledPolicy:
    """Raises ``ValueError`` on an unknown id or preset (naming the known ones) or an unsupported spec major."""
    version = str(policy.get("specVersion", ""))
    major = version.split(".")[0]
    if not major.isdigit() or int(major) != SUPPORTED_MAJOR:
        raise ValueError(f"policy specVersion {version} is not supported; this package implements spec {SUPPORTED_MAJOR}.x")
    entries = policy.get("checks")
    if not isinstance(entries, list) or not entries:
        raise ValueError("policy.checks must be a non-empty array")
    compiled: list[Check] = []
    for entry in entries:
        if not isinstance(entry, Mapping):
            raise ValueError("each policy entry needs an id or a preset")
        options = {k: v for k, v in entry.items() if k not in ("id", "preset", "shadow")}
        preset_name = entry.get("preset")
        check_id = entry.get("id")
        built: list[Check]
        if isinstance(preset_name, str):
            preset = presets.get(preset_name)
            if preset is None:
                raise ValueError(f'unknown preset "{preset_name}"; known presets: {", ".join(presets)}')
            built = preset(options)
        elif isinstance(check_id, str):
            factory = KNOWN_CHECKS.get(check_id)
            if factory is None:
                raise ValueError(f'unknown check "{check_id}"; known checks: {", ".join(KNOWN_CHECKS)}')
            built = [factory(options)]
        else:
            raise ValueError("each policy entry needs an id or a preset")
        if entry.get("shadow"):
            for check in built:
                check.shadow = True
        compiled.extend(built)
    on_store_error: StoreErrorMode = "closed" if policy.get("onStoreError") == "closed" else "open"
    return CompiledPolicy(tuple(compiled), on_store_error, str(policy.get("keyPrefix", "pg:")))


load_policy = compile_policy

__all__ = ["KNOWN_CHECKS", "CompiledPolicy", "compile_policy", "load_policy"]
