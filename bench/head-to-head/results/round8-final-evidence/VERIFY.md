# Verify round8-final (checklist for another LLM)

Run every command from this folder. Report each check as pass or fail with the output you saw.

1. **Protocol frozen before the runs.** Open `PROTOCOL.md`. In the repository run
   `git log --format='%h %ad %s' --date=iso -- docs/HEAD-TO-HEAD.md` and `git show -s --format='%h %ci' f160af98731ce59b25a34051f8630db6dfef713f`.
   Then `grep -h '"startedAt"' runs/*/*/*/*/cost.json | sort | head -1` gives the first run time (UTC, with Z).
   Proves: the protocol commit `f160af98731ce59b25a34051f8630db6dfef713f` is older than the earliest cell. Convert both to UTC before comparing.
2. **No reused cells.** `grep -h '"sessionId"' runs/*/*/*/*/cost.json | sort | uniq -d` must print nothing (every cell has its own session).
   `grep -h '"modelId"' runs/*/*/*/*/cost.json | sort | uniq -c` lists the model of every cell; it must match `env.json`.
   Proves: no cell is a copy of another, and no cell ran on a different model than reported.
3. **Scores recompute.** `python3 score.py --check SUMMARY.md` must print CHECK OK and exit 0. `python3 score.py` prints the tables
   from `grades/` and `runs/*/*/*/*/cost.json` only (no network, no model). Proves: the numbers in SUMMARY.md follow from the stored grades.
   To check a grade by hand, open `grades/<model>/<task>-<arm>-<rep>.json`, then `runs/<model>/<task>/<arm>/<rep>/code/` and `tasks/checkers/<task>.mjs`.
   Grading is by the checker script run on the produced code; there is no model grader (see `grades/README.md`, `grades/parse-failures.json`).
4. **Redaction holds.** Run
   `grep -rIE '/Users/[A-Za-z]|sk-ant-[A-Za-z0-9_-]|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]' . | grep -v example`
   Expected: no home path, no key, no personal e-mail (placeholders are listed in `REDACTION.md`). The builder ran its own scan before it finished.
   Proves: nothing personal is published.
5. **Files are unchanged since the build.** `shasum -a 256 -c SHA256SUMS` must report OK for every file.
6. **Held-out writer did not see the code.** Open `tasks/WRITER.md` and `tasks/WRITER-SPEC.md`: the writer was a fresh Sonnet with an empty config
   folder, shown only the user-problem sentence and the format spec, and the controller did not read the tasks before the gate.
7. **Tasks were not tuned to the code.** The tasks were written before the code change of this round: in the repository run
   `git log --format='%h %ad %s' --date=iso f160af98731ce59b25a34051f8630db6dfef713f~1..5fe287e8472ec32e4c357e9b0c22a484466a3ad0` and confirm that the protocol commit (which freezes the held-out set)
   comes before the commit that changed the code (`5fe287e8472ec32e4c357e9b0c22a484466a3ad0` or an earlier commit of that range). Compare the dates.
8. **Claim matches the tables.** Read the first line of `SUMMARY.md`; it must not claim more than the verdict block shows
   (the word "first" only when the full gate passed, with its scope), and the departures section must list every deviation you found.
