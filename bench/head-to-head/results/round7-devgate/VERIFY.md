# Verify (for another LLM)

1. `git log --oneline` in the repo: check the commit order in `PROTOCOL.md` (rulings before the code and run they govern).
2. `python3 score.py --check SUMMARY.md` must exit 0 (tables recompute from `iter*/*/results.json`, no network, no model).
3. `shasum -a 256 -c SHA256SUMS`.
4. Open `NOTES.md`: every departure is listed; the gate is a development gate, not a score table; no "first" claim exists.
5. Redaction: `grep -r "/Users/" . --exclude=VERIFY.md` returns nothing.
