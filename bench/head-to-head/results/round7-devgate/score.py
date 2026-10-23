#!/usr/bin/env python3
"""Recompute SUMMARY.md of the round-7 development gate from iter*/<set>-<model>/results.json. No network, no model calls.
Usage: python3 score.py            (prints the summary)
       python3 score.py --check SUMMARY.md   (exit 0 when SUMMARY.md equals the output)"""
import json, sys, os
H = os.path.dirname(os.path.abspath(__file__))
REF = {  # frozen in docs/HEAD-TO-HEAD.md, section Round 7 (development gate)
 ("r5","haiku"): {"g1":3.00,"g2":6.00,"g3":6.00,"g4":6.00,"g5":6.00},
 ("r5","sonnet"): {"g1":5.00,"g2":6.00,"g3":6.00,"g4":6.00,"g5":6.00},
 ("c","haiku"): {"g1":5.67,"g2":5.67,"g3":6.00,"g4":6.00,"g5":6.00},
 ("c","sonnet"): {t:6.00 for t in ("g1","g2","g3","g4","g5")},
}
SETN = {"r5": "round-5 held-out set (seen)", "c": "round-6 held-out set c (seen)"}
out = ["# Round 7 development gate (ours x3, SDK path; not part of any score table)", "",
       "Reference = best other arm's published score (c on Sonnet: no rival run exists, so the reference is the task maximum 6.00).",
       "Pass per task: mean strictly above the reference, or at the ceiling (6.00) together with it. Checkers unchanged.", ""]
grand = 0.0
for it in (1, 2, 3):
    commit = open(f"{H}/iter{it}/r5-haiku/COMMIT").read().strip()[:7]
    out += [f"## Iteration {it} (build `{commit}`)", ""]
    itcost = 0.0; ipass = True
    for s in ("r5", "c"):
        for m in ("haiku", "sonnet"):
            cells = json.load(open(f"{H}/iter{it}/{s}-{m}/results.json"))
            by = {}
            for c in cells: by.setdefault(c["task"], []).append(c)
            ref = REF[(s, m)]; row = []; tot = 0.0; ok = True
            for t in sorted(by):
                v = [c["outcome"] for c in sorted(by[t], key=lambda c: c["rep"])]
                mean = sum(v) / len(v); tot += mean
                good = mean > ref[t] + 1e-9 or (abs(ref[t] - 6.0) < 1e-9 and abs(mean - 6.0) < 1e-9)
                ok &= good
                row.append(f"{t} {mean:.2f} {v} ref {ref[t]:.2f} {'ok' if good else 'FAIL'}")
            cost = sum(c["costUsd"] for c in cells); itcost += cost; ipass &= ok
            turns = sum(c["turns"] for c in cells) / len(cells)
            out += [f"- {SETN[s]}, {m}: total {tot:.2f} of 30; {'PASS' if ok else 'FAIL'}; cost {cost:.2f} USD, {turns:.1f} turns per run", "  " + "; ".join(row)]
    out += ["", f"Iteration {it}: {'PASS' if ipass else 'FAIL'}; cell cost {itcost:.2f} USD", ""]
    grand += itcost
out += [f"Development gate cell cost, all iterations: {grand:.2f} USD", ""]
text = "\n".join(out)
if len(sys.argv) > 2 and sys.argv[1] == "--check":
    sys.exit(0 if open(sys.argv[2]).read() == text else 1)
print(text, end="")
