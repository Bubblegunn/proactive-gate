"""``proactive_gate.__version__`` is what an installed package answers, so it has to be true.

It said 0.2.0 through four releases, which was found by installing the published
wheel rather than by any test. scripts/release-gate.mjs compares it in CI too; this
is the half a contributor working only in Python runs.
"""
from __future__ import annotations

import tomllib

import proactive_gate
from conftest import ROOT


def test_version_matches_the_package_metadata() -> None:
    with (ROOT / "python" / "pyproject.toml").open("rb") as handle:
        declared = tomllib.load(handle)["project"]["version"]
    assert proactive_gate.__version__ == declared
