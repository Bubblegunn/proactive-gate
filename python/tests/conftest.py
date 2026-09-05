from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "spec" / "fixtures"
SKIPS = ROOT / "spec" / "skip" / "python.txt"
SPEC_VERSION = (ROOT / "spec" / "SPEC_VERSION").read_text(encoding="utf-8").strip()
