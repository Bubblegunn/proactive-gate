# Isolation finding (found after the measurement, 2026-10-23)

Every cell of this measurement, of the development-gate iterations 1 and 2 and of the probes ran with a working directory below `/Users/efe/...`.
Claude Code reads the `CLAUDE.md` of every ancestor directory, so the owner's `/Users/efe/.claude/CLAUDE.md` (caveman answer style, the commit-format
rule, RTK, design-skill defaults) was loaded as project memory in every arm. The wrapper's HOME override does not prevent it. Found by the
product-engineer controller and reported in `~/claude-kredi-runs/2026-10-23/ISOLATION-WARNING-from-product-engineer.md`.

Check on this folder: the word `caveman` occurs in the transcript of 88 of 108 public-set cells and 74 of 90 held-out-d cells (all arms alike).
The exposure is the same for every arm, but the instruction changes how every agent writes and answers, so the scores are not a clean measurement of the
plugin. They are kept as a record. No claim of any kind rests on them. The wrapper now refuses to run below /Users/efe; a repeat must use a folder under /private/tmp.
