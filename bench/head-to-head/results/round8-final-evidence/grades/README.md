# Grades

- Grading is by the task's checker script (`../tasks/checkers/<task>.mjs`), run on the code the agent produced (`../runs/<model>/<task>/<arm>/<rep>/code/`). There is no model grader.
- Every cell of a result folder was scored in one `score.mjs` call, so there is no grading order and no shuffle.
- Each file `<model>/<task>-<arm>-<rep>.json` holds the parsed per-criterion result: criterion name, pass, why (the checker's failure text), and the label from `tasks/labels.json` (`outcome` or `process`).
  The outcome score of a cell is the number of passed criteria labelled `outcome`; `score.py` recomputes it from the criteria.
- Cells whose checker printed no result are listed in `parse-failures.json` (an empty list when none). Such a cell has no criteria and scores 0.
- There are no re-asks: each cell was graded once.
