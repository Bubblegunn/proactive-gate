#!/usr/bin/env python3
"""Development-gate statistics for one model and one task set.

usage: devgate-bootstrap.py RESULTS.json [RESULTS.json ...] --ours ours [--seed 7] [--resamples 10000]

Each results.json is the list score.mjs writes (one entry per cell: arm, task, rep, outcome, costUsd, turns).
For every arm: total of per-task means (max = sum of outcomeMax), mean cost per run, mean turns.
For the pair (ours, best other arm): the 95 percent percentile bootstrap interval of
(ours total - best other total), resampling the repetitions of each task with replacement, independently
per arm; the best other arm is chosen inside every resample (so the interval is not helped by picking the
rival after the fact). Prints a markdown table and one JSON line. Exit 0 always; the gate reads the numbers.
"""
import json, random, sys, argparse, collections

ap = argparse.ArgumentParser()
ap.add_argument("files", nargs="+")
ap.add_argument("--ours", default="ours")
ap.add_argument("--seed", type=int, default=7)
ap.add_argument("--resamples", type=int, default=10000)
a = ap.parse_args()

cells = []
for f in a.files:
    cells += json.load(open(f))
by = collections.defaultdict(lambda: collections.defaultdict(list))  # arm -> task -> [scores]
cost = collections.defaultdict(list); turns = collections.defaultdict(list)
mx = {}
for c in cells:
    by[c["arm"]][c["task"]].append(c["outcome"])
    mx[c["task"]] = c.get("outcomeMax", 6)
    if c.get("costUsd") is not None: cost[c["arm"]].append(c["costUsd"])
    if c.get("turns") is not None: turns[c["arm"]].append(c["turns"])
tasks = sorted(mx)
arms = sorted(by)
tot = {arm: sum(sum(by[arm][t]) / len(by[arm][t]) for t in tasks if by[arm][t]) for arm in arms}
rng = random.Random(a.seed)

def draw(arm):
    return sum(sum(rng.choices(by[arm][t], k=len(by[arm][t]))) / len(by[arm][t]) for t in tasks if by[arm][t])

others = [x for x in arms if x != a.ours]
diffs = []
for _ in range(a.resamples):
    o = draw(a.ours)
    diffs.append(o - max(draw(x) for x in others))
diffs.sort()
lo, hi = diffs[int(0.025 * a.resamples)], diffs[int(0.975 * a.resamples) - 1]
best = max(others, key=lambda x: tot[x])
print("| arm | total of means (max %.0f) | cost per run USD | turns per run | cells |" % sum(mx.values()))
print("|---|---|---|---|---|")
for arm in arms:
    n = sum(len(v) for v in by[arm].values())
    print("| %s | %.2f | %.3f | %.1f | %d |" % (arm, tot[arm], sum(cost[arm]) / max(1, len(cost[arm])), sum(turns[arm]) / max(1, len(turns[arm])), n))
print()
print("ours minus best other (%s by point estimate): %.2f, 95%% bootstrap interval [%.2f, %.2f], %d resamples, seed %d" % (best, tot[a.ours] - tot[best], lo, hi, a.resamples, a.seed))
print(json.dumps({"ours": tot[a.ours], "best_other": best, "best_other_total": tot[best], "diff": tot[a.ours] - tot[best], "lo": lo, "hi": hi,
                  "ours_cost": sum(cost[a.ours]) / max(1, len(cost[a.ours])), "baseline_cost": sum(cost["baseline"]) / max(1, len(cost["baseline"])) if "baseline" in cost else None}))
