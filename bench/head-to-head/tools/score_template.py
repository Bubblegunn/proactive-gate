#!/usr/bin/env python3
"""Recompute every table and the gate verdict of this evidence folder.

Reads ONLY grades/<model>/*.json and runs/<model>/<task>/<arm>/<rep>/cost.json. No network, no model call.

  python3 score.py                  print the tables and the verdict
  python3 score.py --check FILE     exit 1 unless the block between the score.py markers in FILE equals this output byte for byte
"""
import glob
import json
import os
import sys
from fractions import Fraction

BASE = os.path.dirname(os.path.abspath(__file__))
ARMS = ["ours", "baseline", "knock", "knock-inv", "courier", "courier-inv"]
SET_TITLE = {"heldout": "held-out set", "public": "public set"}
BEGIN = b"<!-- score.py begin -->\n"
END = b"<!-- score.py end -->\n"


def load():
    """groups[(model, set)] = {"scores": {(task, arm, rep): (score, max)}, "costs": {(task, arm, rep): (usd, turns)}}"""
    groups = {}

    def group(model, kind):
        return groups.setdefault((model, kind), {"scores": {}, "costs": {}})

    for path in sorted(glob.glob(os.path.join(BASE, "grades", "*", "*.json"))):
        with open(path, encoding="utf-8") as f:
            g = json.load(f)
        score = sum(1 for c in g["criteria"] if c["pass"] and c["label"] == "outcome")
        group(g["model"], g["set"])["scores"][(g["task"], g["arm"], int(g["rep"]))] = (score, int(g["outcomeMax"]))
    for path in sorted(glob.glob(os.path.join(BASE, "runs", "*", "*", "*", "*", "cost.json"))):
        with open(path, encoding="utf-8") as f:
            c = json.load(f)
        group(c["model"], c["set"])["costs"][(c["task"], c["arm"], int(c["rep"]))] = (c.get("costUsd"), c.get("turns"))
    return groups


def f2(x):
    return f"{float(x):.2f}"


def mean(xs):
    return Fraction(sum(xs), len(xs)) if xs else None


def run_lines(model, kind, data):
    out = []
    scores, costs = data["scores"], data["costs"]
    arms = [a for a in ARMS if any(k[1] == a for k in list(scores) + list(costs))]
    arms += sorted({k[1] for k in list(scores) + list(costs)} - set(ARMS))
    tasks = sorted({k[0] for k in scores})
    if not arms or not tasks:
        return [f"## {model}, {SET_TITLE.get(kind, kind)}", "", "n/a: no graded cells", ""]
    runs = {(t, a): [scores[(t, a, r)][0] for r in sorted({k[2] for k in scores if k[:2] == (t, a)})] for t in tasks for a in arms}
    tmax = {t: max(v[1] for k, v in scores.items() if k[0] == t) for t in tasks}
    m = {(t, a): mean(runs[(t, a)]) for t in tasks for a in arms}
    total = {a: (sum(m[(t, a)] for t in tasks) if all(m[(t, a)] is not None for t in tasks) else None) for a in arms}
    grand = sum(tmax.values())

    out += [f"## {model}, {SET_TITLE.get(kind, kind)}", "", "### Outcome score per task", "",
            "Each cell: mean [score of each run] (min-max, n runs). Score of a run = outcome criteria passed.", "",
            "| task (max) | " + " | ".join(arms) + " |", "|---|" + "---|" * len(arms)]
    for t in tasks:
        cells = []
        for a in arms:
            v = runs[(t, a)]
            cells.append("n/a" if not v else f"{f2(m[(t, a)])} [{', '.join(map(str, v))}] ({min(v)}-{max(v)}, n={len(v)})")
        out.append(f"| {t} ({tmax[t]}) | " + " | ".join(cells) + " |")
    out.append(f"| total of means ({grand}) | " + " | ".join("n/a" if total[a] is None else f2(total[a]) for a in arms) + " |")

    cost_of = {}
    turns_of = {}
    for a in arms:
        cs = [v[0] for k, v in costs.items() if k[1] == a and v[0] is not None]
        ts = [v[1] for k, v in costs.items() if k[1] == a and v[1] is not None]
        cost_of[a] = sum(cs) / len(cs) if cs else None
        turns_of[a] = sum(ts) / len(ts) if ts else None
    base = cost_of.get("baseline")

    def ratio(a):
        return f"{cost_of[a] / base:.2f}" if cost_of.get(a) is not None and base else "n/a"

    out += ["", "### Cost", "", "| measure | " + " | ".join(arms) + " |", "|---|" + "---|" * len(arms),
            "| mean cost USD per run | " + " | ".join("n/a" if cost_of[a] is None else f"{cost_of[a]:.3f}" for a in arms) + " |",
            "| cost vs baseline | " + " | ".join(ratio(a) for a in arms) + " |",
            "| mean turns per run | " + " | ".join("n/a" if turns_of[a] is None else f"{turns_of[a]:.1f}" for a in arms) + " |"]

    verdicts = []  # True, False or None (cannot be decided from the data)
    others = [a for a in arms if a != "ours"]
    out += ["", "### Verdict", ""]
    if "ours" not in arms:
        out += ["n/a: no cells for arm ours", ""]
        return out

    out += ["Rule B (per task): ours mean must be strictly above the mean of every other arm. If another arm is at the task maximum,",
            "ours must be at the task maximum too (strictly above is impossible there).", ""]
    for t in tasks:
        if m[(t, "ours")] is None:
            out.append(f"- {t}: n/a (no ours cells)")
            verdicts.append(None)
            continue
        o = m[(t, "ours")]
        parts, ok, unknown = [], True, False
        for a in others:
            x = m[(t, a)]
            if x is None:
                parts.append(f"{a} n/a")
                unknown = True
            elif o > x:
                parts.append(f"{a} {f2(x)}: {f2(o)} > {f2(x)} ok")
            elif x == tmax[t] and o == tmax[t]:
                parts.append(f"{a} {f2(x)}: both at maximum {tmax[t]} ok")
            else:
                parts.append(f"{a} {f2(x)}: {f2(o)} not above, FAIL")
                ok = False
        res = False if not ok else (None if unknown else True)
        verdicts.append(res)
        out.append(f"- {t} (max {tmax[t]}): ours {f2(o)}; " + "; ".join(parts) + f" => Rule B {'PASS' if res else 'FAIL' if res is False else 'n/a'}")

    out += ["", "Rule A: ours lost points = total max - total of means. Best other arm = the other arm with the highest total of means.",
            "Pass when ours lost <= 0.8 x best other lost.", ""]
    lost = {a: (grand - total[a] if total[a] is not None else None) for a in arms}
    for a in arms:
        out.append(f"- {a}: total of means {'n/a' if total[a] is None else f2(total[a])} of {grand}; lost {'n/a' if lost[a] is None else f2(lost[a])}")
    complete_others = [a for a in others if total[a] is not None]
    if total["ours"] is None or not complete_others:
        out.append("- Rule A: n/a (ours or every other arm is incomplete)")
        verdicts.append(None)
    else:
        best = max(complete_others, key=lambda a: (total[a], -others.index(a)))
        limit = Fraction(4, 5) * lost[best]
        ok = lost["ours"] <= limit
        verdicts.append(ok)
        out.append(f"- best other arm: {best} (total {f2(total[best])}, lost {f2(lost[best])}); 0.8 x {f2(lost[best])} = {f2(limit)}; "
                   f"ours lost {f2(lost['ours'])} <= {f2(limit)} is {'true' if ok else 'false'} => Rule A {'PASS' if ok else 'FAIL'}")

    out += ["", "Ceiling rule: on a task where another arm's mean equals the task maximum, ours must equal the maximum as well; it is applied inside Rule B above.", ""]
    out.append("Cost rule: mean cost per run of ours must not be above the mean cost per run of the baseline arm (same environment).")
    if cost_of.get("ours") is None or base is None:
        out.append("- cost: n/a (ours or baseline has no cost data)")
        verdicts.append(None)
    else:
        ok = cost_of["ours"] <= base
        verdicts.append(ok)
        out.append(f"- ours {cost_of['ours']:.6f} USD <= baseline {base:.6f} USD is {'true' if ok else 'false'} => Cost rule {'PASS' if ok else 'FAIL'}")

    gate = "FAIL" if any(v is False for v in verdicts) else ("n/a" if any(v is None for v in verdicts) else "PASS")
    out += ["", f"GATE {model} ({SET_TITLE.get(kind, kind)}): {gate} (PASS only when Rule A, Rule B on every task and the cost rule all pass)", ""]
    return out


def render():
    groups = load()
    if not groups:
        return "n/a: no grades found\n"
    lines = []
    for model, kind in sorted(groups):
        lines += run_lines(model, kind, groups[(model, kind)])
    return "\n".join(lines).rstrip("\n") + "\n"


def block_of(data):
    i = data.find(BEGIN)
    j = data.find(END, i + len(BEGIN)) if i >= 0 else -1
    if i < 0 or j < 0:
        return None
    return data[i + len(BEGIN):j]


def main(argv):
    text = render()
    if "--check" in argv:
        path = argv[argv.index("--check") + 1]
        with open(path, "rb") as f:
            block = block_of(f.read())
        if block is None:
            print(f"CHECK FAILED: markers not found in {path}", file=sys.stderr)
            return 1
        if block != text.encode("utf-8"):
            print(f"CHECK FAILED: the block in {path} differs from the output of score.py", file=sys.stderr)
            return 1
        print(f"CHECK OK: the block in {path} equals the output of score.py byte for byte")
        return 0
    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
