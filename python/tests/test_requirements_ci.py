"""CI installs ``requirements-ci.txt`` with ``--require-hashes``; it has to cover what it is compiled from.

The file is compiled (command in its header) from the dev extra in pyproject.toml and
from requirements-ci.in, so pip can install the test, build and check tools pinned by
hash, and the package itself goes in with ``--no-deps``. A requirement added to either
input without recompiling would otherwise surface only as an ImportError in CI, and a
pin outside its range would mean CI tests against a version the inputs exclude.
"""
from __future__ import annotations

import re
import tomllib

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

from conftest import ROOT

PYTHON = ROOT / "python"


def _inputs() -> list[Requirement]:
    with (PYTHON / "pyproject.toml").open("rb") as handle:
        dev = tomllib.load(handle)["project"]["optional-dependencies"]["dev"]
    lines = (PYTHON / "requirements-ci.in").read_text(encoding="utf-8").splitlines()
    tools = [line for line in (raw.split("#", 1)[0].strip() for raw in lines) if line]
    return [Requirement(spec) for spec in [*dev, *tools]]


def _pins() -> dict[str, tuple[str, int]]:
    text = (PYTHON / "requirements-ci.txt").read_text(encoding="utf-8")
    pins: dict[str, tuple[str, int]] = {}
    # A requirement starts at column 0; its hashes follow on indented continuation lines.
    for block in re.split(r"\n(?=[a-z0-9])", text):
        m = re.match(r"([a-z0-9][a-z0-9._-]*)==(\S+)", block)
        if m:
            pins[canonicalize_name(m.group(1))] = (m.group(2), len(re.findall(r"--hash=sha256:[0-9a-f]{64}", block)))
    return pins


def test_every_input_is_pinned_inside_its_range() -> None:
    pins = _pins()
    wrong = []
    for req in _inputs():
        pinned = pins.get(canonicalize_name(req.name))
        if pinned is None or not req.specifier.contains(pinned[0], prereleases=True):
            wrong.append(f"{req} -> {pinned[0] if pinned else 'not pinned'}")
    assert wrong == []


def test_every_pin_carries_a_hash() -> None:
    pins = _pins()
    assert len(pins) > 0
    assert [name for name, (_, hashes) in pins.items() if hashes == 0] == []
