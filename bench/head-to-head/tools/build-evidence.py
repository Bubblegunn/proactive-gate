#!/usr/bin/env python3
"""Build the evidence folder of a head-to-head round (standard: EVIDENCE-SPEC.md, 11 items). Python 3.11, stdlib only.

  python3 build-evidence.py --out EVIDENCEDIR --round-id ID --held-out-tasks TASKSDIR \
      --models haiku=RESULTDIR,sonnet=RESULTDIR [--public-models haiku=RESULTDIR,... --public-tasks DIR] \
      --protocol-sha SHA --build-sha SHA --date YYYY-MM-DD
  python3 build-evidence.py --out EVIDENCEDIR --refresh      rewrite only the score.py block of SUMMARY.md (and SHA256SUMS)

Each RESULTDIR is a run.mjs output folder (runs/, work/, results.json, COMMIT). Cells without a meta file are skipped.
"""
import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
HOME = os.path.expanduser("~")
HOME_VARIANTS = sorted({HOME.rstrip("/"), os.path.realpath(HOME).rstrip("/")} - {""}, key=len, reverse=True)
ARM_ORDER = ["ours", "baseline", "knock", "knock-inv", "courier", "courier-inv"]
BEGIN = "<!-- score.py begin -->\n"
END = "<!-- score.py end -->\n"
TRACE_CUT = 3000
CODE_MAX = 200 * 1024
TASK_ITEMS = ["prompts", "checkers", "fixtures", "ref", "labels.json", "LABELS.md", "TASKS.md", "WRITER-SPEC.md"]

# ---------------------------------------------------------------- redaction
# Besides the folder that ~ resolves to, any /Users/<name> or /home/<name> path is a personal home path (the runs may have been made under another HOME).
HOME_GENERIC = re.compile(r"/(?:Users|home)/[A-Za-z0-9._-]+")
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
EMAIL_OK = re.compile(r"@(?:[A-Za-z0-9-]+\.)*(?:example\.(?:com|org|net)|[A-Za-z0-9-]+\.(?:test|invalid|example)|localhost)$", re.I)
KEY_PATTERNS = [
    re.compile(r"sk-ant-[A-Za-z0-9_-]+"),
    re.compile(r"(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"xox[abprs]-[A-Za-z0-9-]{10,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"AIza[0-9A-Za-z_-]{30,}"),
    re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)"),
]
LONG_TOKEN = re.compile(r"(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])")


def long_token_is_secret(s):
    """32+ characters of [A-Za-z0-9_-] with upper case, lower case and a digit. Hex hashes, UUIDs and tool ids are not secrets."""
    if re.match(r"(?:toolu|msg|req|srvtoolu)_", s):
        return False
    return bool(re.search(r"[A-Z]", s) and re.search(r"[a-z]", s) and re.search(r"[0-9]", s))


class Redactor:
    def __init__(self):
        self.counts = {"home": 0, "email": 0, "key": 0}

    def text(self, s):
        for h in HOME_VARIANTS:
            n = s.count(h)
            if n:
                self.counts["home"] += n
                s = s.replace(h, "<HOME>")

        s, n = HOME_GENERIC.subn("<HOME>", s)
        self.counts["home"] += n

        def email(m):
            if EMAIL_OK.search(m.group(0)):
                return m.group(0)
            self.counts["email"] += 1
            return "<EMAIL>"
        s = EMAIL.sub(email, s)
        for p in KEY_PATTERNS:
            s, n = p.subn("<KEY>", s)
            self.counts["key"] += n

        def long(m):
            if long_token_is_secret(m.group(0)):
                self.counts["key"] += 1
                return "<KEY>"
            return m.group(0)
        return LONG_TOKEN.sub(long, s)


def scan_findings(root):
    """Re-read every file under root from disk. Returns a list of (relpath, kind)."""
    bad = []
    for dp, _dn, fns in os.walk(root):
        for fn in fns:
            p = os.path.join(dp, fn)
            rel = os.path.relpath(p, root)
            with open(p, "rb") as f:
                raw = f.read()
            for h in HOME_VARIANTS:
                if h.encode() in raw:
                    bad.append((rel, "home path"))
            try:
                t = raw.decode("utf-8")
            except UnicodeDecodeError:
                continue
            if HOME_GENERIC.search(t):
                bad.append((rel, "home path"))
            if any(not EMAIL_OK.search(m.group(0)) for m in EMAIL.finditer(t)):
                bad.append((rel, "e-mail"))
            if any(p_.search(t) for p_ in KEY_PATTERNS) or any(long_token_is_secret(m.group(0)) for m in LONG_TOKEN.finditer(t)):
                bad.append((rel, "key or token"))
    return bad


# ---------------------------------------------------------------- helpers
def write(path, text, red=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if red is not None:
        text = red.text(text)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def write_json(path, obj, red=None, indent=1):
    write(path, json.dumps(obj, indent=indent, ensure_ascii=False) + "\n", red)


def read_text(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return None


def read_json(path):
    t = read_text(path)
    try:
        return json.loads(t) if t is not None else None
    except json.JSONDecodeError:
        return None


def parse_models(arg):
    out = []
    for part in [p for p in (arg or "").split(",") if p.strip()]:
        name, _, path = part.partition("=")
        if not name or not path:
            sys.exit(f"bad --models entry: {part!r} (want name=DIR)")
        out.append((name.strip(), os.path.abspath(path.strip())))
    return out


def copy_tasks(src, dst, red):
    os.makedirs(dst, exist_ok=True)
    for item in TASK_ITEMS:
        s = os.path.join(src, item)
        if not os.path.exists(s):
            continue
        d = os.path.join(dst, item)
        if os.path.isdir(s):
            shutil.copytree(s, d, symlinks=False, ignore=shutil.ignore_patterns("node_modules", ".DS_Store"), dirs_exist_ok=True)
        else:
            shutil.copy2(s, d)
    for dp, _dn, fns in os.walk(dst):
        for fn in fns:
            p = os.path.join(dp, fn)
            if os.path.islink(p):
                os.remove(p)
                continue
            t = read_text(p)
            if t is not None:
                nt = red.text(t)
                if nt != t:
                    write(p, nt)


def flat_content(c):
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(b.get("text", "") if isinstance(b, dict) and b.get("type") == "text" else (json.dumps(b, ensure_ascii=False) if isinstance(b, dict) else str(b)) for b in c)
    return json.dumps(c, ensure_ascii=False)


def parse_log(path):
    """Returns (trace events, final text or None, result message or None, first timestamp, last timestamp)."""
    events, final, result, first_ts, last_ts = [], None, None, None, None
    for line in (read_text(path) or "").splitlines():
        try:
            o = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(o, dict):
            continue
        t = o.get("type")
        ts = o.get("timestamp")
        if ts:
            first_ts = first_ts or ts
            last_ts = ts
        if t == "result":
            result = o
            final = o.get("result") if isinstance(o.get("result"), str) else final
            continue
        if t not in ("assistant", "user"):
            continue
        content = (o.get("message") or {}).get("content")
        if isinstance(content, str):
            events.append({"role": t, "type": "text", "text": content, "timestamp": ts})
            continue
        for b in content or []:
            if not isinstance(b, dict):
                continue
            bt = b.get("type")
            if bt == "text":
                events.append({"role": t, "type": "text", "text": b.get("text", ""), "timestamp": ts})
            elif bt == "tool_use":
                events.append({"role": t, "type": "tool_use", "id": b.get("id"), "name": b.get("name"), "input": b.get("input"), "timestamp": ts})
            elif bt == "tool_result":
                s = flat_content(b.get("content"))
                ev = {"role": t, "type": "tool_result", "tool_use_id": b.get("tool_use_id"), "is_error": bool(b.get("is_error", False)), "content": s, "timestamp": ts}
                events.append(ev)
    return events, final, result, first_ts, last_ts


def collect_code(work):
    files, skipped = [], []
    if not os.path.isdir(work):
        return files, skipped
    for dp, dn, fns in os.walk(work):
        dn[:] = sorted(d for d in dn if d != "node_modules" and not d.startswith("."))
        for fn in sorted(fns):
            if fn.startswith("."):
                continue
            p = os.path.join(dp, fn)
            rel = os.path.relpath(p, work)
            if os.path.islink(p):
                skipped.append(f"{rel}: symlink")
                continue
            if os.path.getsize(p) > CODE_MAX:
                skipped.append(f"{rel}: larger than 200 KB")
                continue
            t = read_text(p)
            if t is None or "\0" in t:
                skipped.append(f"{rel}: not a text file")
                continue
            files.append((rel, t))
    return files, skipped


# ---------------------------------------------------------------- build parts
def build_cells(out, model, kind, resdir, labels, red, stats):
    runs_dir = os.path.join(resdir, "runs")
    results = read_json(os.path.join(resdir, "results.json")) or []
    by_name = {r.get("name"): r for r in results}
    if not results:
        print(f"warning: {resdir}/results.json is missing or empty: no grades for {model}", file=sys.stderr)
    failures = []
    names = sorted(f[:-len(".meta.json")] for f in os.listdir(runs_dir) if f.endswith(".meta.json")) if os.path.isdir(runs_dir) else []
    for name in names:
        meta = read_json(os.path.join(runs_dir, name + ".meta.json"))
        log = os.path.join(runs_dir, name + ".jsonl")
        if not meta or not os.path.exists(log):
            continue
        task, arm, rep = meta["task"], meta["arm"], int(meta["rep"])
        cell = os.path.join(out, "runs", model, task, arm, str(rep))
        events, final, result, first_ts, last_ts = parse_log(log)
        write(os.path.join(cell, "final.md"), (final if final is not None else "(no result message in the log)") + "\n", red)
        lines = []
        for ev in events:
            if ev["type"] == "tool_result":
                ev["content"] = red.text(ev["content"])
                if len(ev["content"]) > TRACE_CUT:
                    ev["content"] = ev["content"][:TRACE_CUT]
                    ev["truncated"] = True
            lines.append(red.text(json.dumps(ev, ensure_ascii=False)))
        write(os.path.join(cell, "trace.jsonl"), "\n".join(lines) + ("\n" if lines else ""))
        files, skipped = collect_code(meta.get("work", ""))
        for rel, t in files:
            write(os.path.join(cell, "code", rel), t, red)
        cost = {"model": model, "modelId": meta.get("model"), "set": kind, "task": task, "arm": arm, "rep": rep, "costUsd": meta.get("costUsd"), "turns": meta.get("turns"),
                "seconds": meta.get("seconds"), "skillCalls": meta.get("skillCalls"), "exitCode": meta.get("code"),
                "sessionId": (result or {}).get("session_id"), "startedAt": first_ts, "finishedAt": last_ts, "codeFiles": len(files), "codeSkipped": skipped}
        write_json(os.path.join(cell, "cost.json"), cost, red)
        stats.append(cost)
        row = by_name.get(name)
        if row is None:
            continue
        lab = labels.get(task, {})
        crit = [{"n": c.get("n"), "name": c.get("name"), "pass": bool(c.get("pass")), "why": c.get("why", ""),
                 "label": (lab.get(str(c.get("n")), {}) or {}).get("label", "outcome")} for c in row.get("criteria", [])]
        grade = {"model": model, "set": kind, "task": task, "arm": arm, "rep": rep, "name": name, "checkerDetail": row.get("detail"), "criteria": crit,
                 "outcomeScore": sum(1 for c in crit if c["pass"] and c["label"] == "outcome"), "outcomeMax": row.get("outcomeMax"),
                 "fullScore": sum(1 for c in crit if c["pass"]), "fullMax": len(crit)}
        write_json(os.path.join(out, "grades", model, f"{task}-{arm}-{rep}.json"), grade, red)
        if row.get("detail") != "ok" or not crit:
            failures.append({"model": model, "set": kind, "cell": f"{task}-{arm}-{rep}", "detail": row.get("detail")})
    return failures


def licence_of(dirs, rel):
    for d in dirs:
        t = read_text(os.path.join(d, "_setup", *rel))
        if t:
            for line in t.splitlines():
                if line.strip():
                    return line.strip()
    return None


def build_arms(args, resdirs, commit):
    knock_lic = licence_of(resdirs, ["knock", "LICENSE"]) or "see repo"
    return {"arms": [
        {"name": "ours", "kind": "product under test", "source": "https://github.com/Bubblegunn/proactive-gate", "licence": "MIT", "pinned": commit,
         "install": "git archive of the commit, built, packed with npm pack; the archive is the plugin directory and the packed tarball is a file: dependency of the fixture",
         "promptPrefix": "", "invoked": False},
        {"name": "baseline", "kind": "control, empty plugin", "source": "bench/head-to-head/arms/baseline in this repository", "licence": "MIT", "pinned": commit,
         "install": "empty plugin directory bench/head-to-head/arms/baseline (manifest only)", "promptPrefix": "", "invoked": False},
        {"name": "knock", "kind": "competitor, task text alone", "source": "https://github.com/knocklabs/skills", "licence": knock_lic,
         "pinned": "cc99682ed74ee34198602c7d28569bd1c5f309d3", "install": "git clone at the pinned commit, used as a plugin directory, skills only (--strict-mcp-config, no MCP server)",
         "promptPrefix": "", "invoked": False},
        {"name": "knock-inv", "kind": "competitor, invoked", "source": "https://github.com/knocklabs/skills", "licence": knock_lic,
         "pinned": "cc99682ed74ee34198602c7d28569bd1c5f309d3", "install": "same plugin directory as knock",
         "promptPrefix": "Use the knock-notification-best-practices skill from the Knock skills plugin for this. ", "invoked": True},
        {"name": "courier", "kind": "competitor, task text alone", "source": "https://github.com/trycourier/courier-skills", "licence": "MIT (courier-skills, version 1.8.1)",
         "pinned": "18c7bcbeee6d5deb58a0d9dfec9ded4f960b2132 (version 1.8.1)",
         "install": "git archive of skills/courier and LICENSE at the pinned commit into a generated local plugin with a minimal manifest; MCP server not copied; --strict-mcp-config; no COURIER_API_KEY",
         "promptPrefix": "", "invoked": False},
        {"name": "courier-inv", "kind": "competitor, invoked", "source": "https://github.com/trycourier/courier-skills", "licence": "MIT (courier-skills, version 1.8.1)",
         "pinned": "18c7bcbeee6d5deb58a0d9dfec9ded4f960b2132 (version 1.8.1)", "install": "same generated plugin as courier",
         "promptPrefix": "Use the courier skill from the Courier skills plugin for this. ", "invoked": True},
    ], "note": "Every other arm gets the task text alone. ours is this repository at the build sha; the COMMIT file of each result folder holds the full sha."}


def node_version():
    try:
        return subprocess.run(["node", "--version"], capture_output=True, text=True, timeout=10).stdout.strip() or "n/a"
    except (OSError, subprocess.SubprocessError):
        return "n/a"


def repo_url():
    try:
        u = subprocess.run(["git", "-C", REPO, "remote", "get-url", "origin"], capture_output=True, text=True, timeout=10).stdout.strip()
        return re.sub(r"//[^/@]+@", "//", u) or "<URL of this repository>"
    except (OSError, subprocess.SubprocessError):
        return "<URL of this repository>"


def protocol_section():
    t = read_text(os.path.join(REPO, "docs", "HEAD-TO-HEAD.md")) or ""
    lines = t.splitlines()
    start = next((i for i, l in enumerate(lines) if l.startswith("## Round 5 (frozen")), None)
    if start is None:
        return None
    end = len(lines)
    for i in range(start + 1, len(lines)):
        if lines[i].startswith("## "):
            end = i
            break
    return "\n".join(lines[start:end]).rstrip() + "\n"


def sha256sums(out):
    rows = []
    for dp, _dn, fns in os.walk(out):
        for fn in fns:
            p = os.path.join(dp, fn)
            rel = os.path.relpath(p, out)
            if rel == "SHA256SUMS":
                continue
            h = hashlib.sha256()
            with open(p, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            rows.append((rel, h.hexdigest()))
    rows.sort(key=lambda r: r[0].encode("utf-8"))
    write(os.path.join(out, "SHA256SUMS"), "".join(f"{h}  {rel}\n" for rel, h in rows))
    return len(rows)


def run_score(out):
    r = subprocess.run([sys.executable, "-I", os.path.join(out, "score.py")], capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        sys.exit(f"score.py failed: {r.stderr}")
    return r.stdout


def refresh(out):
    path = os.path.join(out, "SUMMARY.md")
    with open(path, encoding="utf-8", newline="") as f:
        t = f.read()
    i = t.find(BEGIN)
    j = t.find(END, i + len(BEGIN)) if i >= 0 else -1
    if i < 0 or j < 0:
        sys.exit("SUMMARY.md has no score.py markers")
    t = t[:i + len(BEGIN)] + run_score(out) + t[j:]
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(t)
    n = sha256sums(out)
    print(f"SUMMARY.md block refreshed; SHA256SUMS rewritten ({n} files)")
    print(f"verify: cd {out}; shasum -a 256 -c SHA256SUMS")


# ---------------------------------------------------------------- documents
def doc_reproduce(args, stats, sets, arms_seen, tasks_seen):
    by_model = {}
    for c in stats:
        by_model.setdefault((c["model"], c["set"]), []).append(c)
    cost_lines, tot_cost, tot_sec = [], 0.0, 0
    for (m, k), cs in sorted(by_model.items(), key=lambda x: (str(x[0][0]), x[0][1])):
        usd = sum(c["costUsd"] or 0 for c in cs)
        sec = sum(c["seconds"] or 0 for c in cs)
        tot_cost += usd
        tot_sec += sec
        cost_lines.append(f"- {m} ({k}): {len(cs)} cells, {usd:.2f} USD, {sec / 60:.0f} minutes of run time summed over cells (about {sec / 60 / 3:.0f} minutes wall time at parallelism 3)")
    arms = ",".join(a for a in ARM_ORDER if a in arms_seen) or "ours,baseline,knock,knock-inv,courier,courier-inv"
    tasks = ",".join(sorted(tasks_seen)) or "g1,g2,g3,g4,g5"
    model_ids = sorted({c["modelId"] for c in stats if c["modelId"]})
    mflag = model_ids[0] if model_ids else "MODEL_ID"
    return f"""# Reproduce {args.round_id}

Build sha: `{args.build_sha}`. Protocol commit: `{args.protocol_sha}`. Date of the original runs: {args.date}.

## 1. Get the code and the pinned build

```
git clone {repo_url()} proactive-gate
cd proactive-gate
git checkout {args.build_sha}
```

## 2. Extract the tasks

```
mkdir -p ../heldout-tasks
cp -R <EVIDENCEDIR>/tasks/. ../heldout-tasks/
export H2H_TASKS_DIR="$PWD/../heldout-tasks"     # prompts/, checkers/, ref/, labels.json, fixtures/ if any
```

The public set (if included) is in `tasks/public/`; extract it the same way and point `H2H_TASKS_DIR` at it for those tasks.

## 3. Pick the claude binary

```
export H2H_CLAUDE_BIN="$(command -v claude)"      # the plain Claude Code CLI is fine for a stranger
```

The original runs used the local Agent SDK shim (`~/claude-kredi-runs/sdk-shim/claude`, which calls `claude_agent_sdk.query`). The shim is not published.
The CLI path has a different tool and skill set (see `env.json`), so absolute scores and costs can differ.
`H2H_PARALLEL=3` matches the original parallelism. Needs node 22 or newer, npm, git, network, and a logged-in `claude`.

## 4. Rerun (one command per model; rerun.sh clones and pins the competitors, packs the build, runs, and scores)

```
export H2H_PARALLEL=3
bash bench/head-to-head/rerun.sh --commit {args.build_sha} --model {mflag} --reps 3 \\
  --arms {arms} \\
  --tasks {tasks} --out /tmp/rerun-MODEL
```

Use the full model id (a short alias can fail to resolve under the throw-away HOME). Repeat for each model id listed in `env.json`.

## 5. Score the rerun

```
export H2H_NODE_BIN="$(dirname "$(command -v node)")"
node bench/head-to-head/score.mjs --out /tmp/rerun-MODEL
```

## 6. Rebuild an evidence folder from the rerun and rescore

```
python3 bench/head-to-head/tools/build-evidence.py --out /tmp/evidence-rerun --round-id {args.round_id}-rerun \\
  --held-out-tasks ../heldout-tasks --models MODEL=/tmp/rerun-MODEL \\
  --protocol-sha {args.protocol_sha} --build-sha {args.build_sha} --date YYYY-MM-DD
python3 /tmp/evidence-rerun/score.py
```

To rescore the original evidence without any rerun: `python3 score.py` and `python3 score.py --check SUMMARY.md` in this folder.

## Expected cost and time (real totals of the original runs, from `runs/*/*/*/*/cost.json`)

{chr(10).join(cost_lines) if cost_lines else "- no cells"}
- all: {tot_cost:.2f} USD, {tot_sec / 60:.0f} minutes summed over cells

Cost on the SDK path is list price; a CLI run on a subscription or another tier will report different numbers.

## What differs on a rerun

- Model variance: the same cell can score differently on another run. The per-cell spread inside this folder (min-max in the tables) shows the size of it.
- Cost, turns and time vary with the run path (SDK shim or CLI) and the day.
- F6 agreement: see SUMMARY.md
"""


def doc_verify(args):
    return f"""# Verify {args.round_id} (checklist for another LLM)

Run every command from this folder. Report each check as pass or fail with the output you saw.

1. **Protocol frozen before the runs.** Open `PROTOCOL.md`. In the repository run
   `git log --format='%h %ad %s' --date=iso -- docs/HEAD-TO-HEAD.md` and `git show -s --format='%h %ci' {args.protocol_sha}`.
   Then `grep -h '"startedAt"' runs/*/*/*/*/cost.json | sort | head -1` gives the first run time (UTC, with Z).
   Proves: the protocol commit `{args.protocol_sha}` is older than the earliest cell. Convert both to UTC before comparing.
2. **No reused cells.** `grep -h '"sessionId"' runs/*/*/*/*/cost.json | sort | uniq -d` must print nothing (every cell has its own session).
   `grep -h '"modelId"' runs/*/*/*/*/cost.json | sort | uniq -c` lists the model of every cell; it must match `env.json`.
   Proves: no cell is a copy of another, and no cell ran on a different model than reported.
3. **Scores recompute.** `python3 score.py --check SUMMARY.md` must print CHECK OK and exit 0. `python3 score.py` prints the tables
   from `grades/` and `runs/*/*/*/*/cost.json` only (no network, no model). Proves: the numbers in SUMMARY.md follow from the stored grades.
   To check a grade by hand, open `grades/<model>/<task>-<arm>-<rep>.json`, then `runs/<model>/<task>/<arm>/<rep>/code/` and `tasks/checkers/<task>.mjs`.
   Grading is by the checker script run on the produced code; there is no model grader (see `grades/README.md`, `grades/parse-failures.json`).
4. **Redaction holds.** Run
   `grep -rIE '/Users/[A-Za-z]|sk-ant-[A-Za-z0-9_-]|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\\.[A-Za-z]' . | grep -v example`
   Expected: no home path, no key, no personal e-mail (placeholders are listed in `REDACTION.md`). The builder ran its own scan before it finished.
   Proves: nothing personal is published.
5. **Files are unchanged since the build.** `shasum -a 256 -c SHA256SUMS` must report OK for every file.
6. **Held-out writer did not see the code.** Open `tasks/WRITER.md` and `tasks/WRITER-SPEC.md`: the writer was a fresh Sonnet with an empty config
   folder, shown only the user-problem sentence and the format spec, and the controller did not read the tasks before the gate.
7. **Tasks were not tuned to the code.** The tasks were written before the code change of this round: in the repository run
   `git log --format='%h %ad %s' --date=iso {args.protocol_sha}~1..{args.build_sha}` and confirm that the protocol commit (which freezes the held-out set)
   comes before the commit that changed the code (`{args.build_sha}` or an earlier commit of that range). Compare the dates.
8. **Claim matches the tables.** Read the first line of `SUMMARY.md`; it must not claim more than the verdict block shows
   (the word "first" only when the full gate passed, with its scope), and the departures section must list every deviation you found.
"""


def doc_protocol(args):
    sec = protocol_section()
    head = (f"# Protocol of {args.round_id}\n\nFrozen protocol: section \"Round 5 (frozen ...)\" of `docs/HEAD-TO-HEAD.md` in this repository, "
            f"committed in `{args.protocol_sha}` before the first run of this round.\n\n"
            f"Link: `docs/HEAD-TO-HEAD.md` at commit `{args.protocol_sha}` (`git show {args.protocol_sha}:docs/HEAD-TO-HEAD.md`).\n\n"
            "Verbatim copy of the section as it is in the working tree when this folder was built "
            "(compare with the committed version using the command above; the section is not edited after results are seen):\n\n---\n\n")
    return head + (sec if sec else "(the section starting with \"## Round 5 (frozen\" was not found in docs/HEAD-TO-HEAD.md)\n")


def doc_env(args, model_ids, env_models):
    return {"date": args.date, "roundId": args.round_id, "models": env_models, "modelIdsSeenInMeta": model_ids,
            "claudeCliVersion": "2.1.308", "agentSdkPython": "0.2.172",
            "runPath": "Claude Agent SDK shim (~/claude-kredi-runs/sdk-shim/claude -> claude_agent_sdk.query)", "parallelism": 3,
            "os": platform.platform(), "node": node_version(), "noCellReused": True,
            "allArmsRunOnSdkPath": True,
            "sdkVsCli": {"measured": True,
                         "tools": {"sdk": 24, "cli": 17,
                                   "sdkAdds": ["Cron*", "DesignSync", "EnterWorktree", "ExitWorktree", "ListAgents", "Monitor", "PushNotification", "ReportFindings",
                                               "ScheduleWakeup", "SendMessage", "TaskStop", "ToolSearch", "Workflow"],
                                   "sdkLacks": ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "Glob", "Grep", "KillShell", "TaskOutput", "TodoWrite"]},
                         "skills": {"sdk": 18, "cli": 44}, "builtInPlugins": 3, "contextWindow": "1M tokens"}}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--round-id")
    ap.add_argument("--held-out-tasks")
    ap.add_argument("--models", default="")
    ap.add_argument("--public-models", default="")
    ap.add_argument("--public-tasks")
    ap.add_argument("--protocol-sha")
    ap.add_argument("--build-sha")
    ap.add_argument("--date")
    args = ap.parse_args()
    out = os.path.abspath(args.out)
    if args.refresh:
        return refresh(out)
    for k in ("round_id", "held_out_tasks", "protocol_sha", "build_sha", "date"):
        if not getattr(args, k):
            ap.error(f"--{k.replace('_', '-')} is required")
    held = parse_models(args.models)
    pub = parse_models(args.public_models)
    if not held and not pub:
        ap.error("--models (or --public-models) is required")
    if pub and not args.public_tasks:
        ap.error("--public-models needs --public-tasks")
    if os.path.exists(out) and os.listdir(out):
        sys.exit(f"{out} exists and is not empty; refusing to overwrite")
    os.makedirs(out, exist_ok=True)
    red = Redactor()

    # tasks/
    tasks_dir = os.path.join(out, "tasks")
    copy_tasks(os.path.abspath(args.held_out_tasks), tasks_dir, red)
    if pub:
        copy_tasks(os.path.abspath(args.public_tasks), os.path.join(tasks_dir, "public"), red)
    write(os.path.join(tasks_dir, "WRITER.md"),
          "# Who wrote these tasks\n\n"
          "Held-out set (tasks/prompts, tasks/checkers, tasks/ref, tasks/labels.json, tasks/TASKS.md):\n\n"
          "- Writer: a fresh Sonnet agent (`claude-sonnet-5-5`) started with an empty config directory.\n"
          "- Shown to the writer: only the one-sentence user problem and the format specification in `WRITER-SPEC.md`. "
          "The writer was not shown the code of the product, its documentation, the research notes, or any arm.\n"
          "- The controller did not read the tasks before the gate.\n"
          "- The set is published here because it has been used in a gate; it is no longer held-out after that.\n"
          + ("\nPublic set (tasks/public/): the task set that was in the repository before this round; it was not written blind to the product.\n" if pub else ""), red)

    # runs/, grades/
    labels_held = read_json(os.path.join(args.held_out_tasks, "labels.json")) or {}
    labels_pub = (read_json(os.path.join(args.public_tasks, "labels.json")) or {}) if pub else {}
    stats, failures, resdirs, env_models = [], [], [], {}
    for kind, lst, labels in (("heldout", held, labels_held), ("public", pub, labels_pub)):
        for model, d in lst:
            if not os.path.isdir(d):
                sys.exit(f"result folder not found: {d}")
            resdirs.append(d)
            before = len(stats)
            failures += build_cells(out, model, kind, d, labels, red, stats)
            ids = sorted({c["modelId"] for c in stats[before:] if c["modelId"]})
            env_models[f"{model} ({kind})"] = {"resultFolder": os.path.basename(d), "modelIds": ids, "cells": len(stats) - before}
    write_json(os.path.join(out, "grades", "parse-failures.json"), failures, red)
    write(os.path.join(out, "grades", "README.md"),
          "# Grades\n\n"
          "- Grading is by the task's checker script (`../tasks/checkers/<task>.mjs`), run on the code the agent produced (`../runs/<model>/<task>/<arm>/<rep>/code/`). There is no model grader.\n"
          "- Every cell of a result folder was scored in one `score.mjs` call, so there is no grading order and no shuffle.\n"
          "- Each file `<model>/<task>-<arm>-<rep>.json` holds the parsed per-criterion result: criterion name, pass, why (the checker's failure text), and the label from `tasks/labels.json` (`outcome` or `process`).\n"
          "  The outcome score of a cell is the number of passed criteria labelled `outcome`; `score.py` recomputes it from the criteria.\n"
          "- Cells whose checker printed no result are listed in `parse-failures.json` (an empty list when none). Such a cell has no criteria and scores 0.\n"
          "- There are no re-asks: each cell was graded once.\n", red)

    # score.py
    shutil.copy2(os.path.join(HERE, "score_template.py"), os.path.join(out, "score.py"))

    commit = None
    for d in resdirs:
        t = read_text(os.path.join(d, "COMMIT"))
        if t and t.strip():
            commit = t.strip()
            break
    commit = commit or args.build_sha
    if not commit.startswith(args.build_sha) and not args.build_sha.startswith(commit):
        print(f"warning: COMMIT file ({commit}) does not match --build-sha ({args.build_sha})", file=sys.stderr)

    write_json(os.path.join(out, "arms.json"), build_arms(args, resdirs, commit), red)
    model_ids = sorted({c["modelId"] for c in stats if c["modelId"]})
    write_json(os.path.join(out, "env.json"), doc_env(args, model_ids, env_models), red)
    write(os.path.join(out, "PROTOCOL.md"), doc_protocol(args), red)
    arms_seen = {c["arm"] for c in stats}
    tasks_seen = {c["task"] for c in stats if c["set"] == "heldout"} or {c["task"] for c in stats}
    write(os.path.join(out, "REPRODUCE.md"), doc_reproduce(args, stats, None, arms_seen, tasks_seen), red)
    write(os.path.join(out, "VERIFY.md"), doc_verify(args), red)
    write(os.path.join(out, "SUMMARY.md"), "SCOPED RESULT SENTENCE: TO BE WRITTEN BY THE CONTROLLER\n\n" + BEGIN + run_score(out) + END +
          "\n## Departures from the frozen protocol\n\nTO BE WRITTEN BY THE CONTROLLER\n")
    write(os.path.join(out, "REDACTION.md"),
          "# Redaction\n\n"
          "Applied to every text file of this folder (final.md, trace.jsonl, code/, cost.json, grades/, tasks/, documents):\n\n"
          "| what | placeholder |\n|---|---|\n"
          "| the home folder of the machine owner (and its resolved real path), and any path starting with /Users/ or /home/ followed by a name | `<HOME>` |\n"
          "| e-mail addresses (except addresses at example.com, example.org, example.net, *.test, *.invalid, *.example, localhost, which are task fixtures) | `<EMAIL>` |\n"
          "| strings starting with sk-ant- and other API key shapes (sk-..., ghp_..., github_pat_..., xox*-..., AKIA..., AIza..., JWT, PEM private keys) | `<KEY>` |\n"
          "| any other 32+ character run of letters, digits, `_` and `-` that has upper case, lower case and a digit (hex hashes, UUIDs and tool ids are kept) | `<KEY>` |\n\n"
          "Not redacted: the user name as a word outside a path (for example in `ls -l` output), process ids, time stamps.\n"
          "Thinking blocks are not stored. Tool results in trace.jsonl are cut to 3000 characters (`\"truncated\": true`).\n\n"
          f"Replacements made: home paths {red.counts['home']}, e-mail addresses {red.counts['email']}, keys or tokens {red.counts['key']}.\n"
          "After writing, the builder re-read every file and failed if a home path, an e-mail or a key pattern remained.\n")

    bad = scan_findings(out)
    if bad:
        for rel, kind in bad[:50]:
            print(f"REDACTION SCAN FAILED: {kind} in {rel}", file=sys.stderr)
        sys.exit(2)
    n = sha256sums(out)
    print(f"built {out}: {len(stats)} cells, {n} files (+ SHA256SUMS), parse failures {len(failures)}")
    print(f"redaction scan passed (replacements: {red.counts})")
    print(f"verify: cd {out}; shasum -a 256 -c SHA256SUMS")
    print(f"rescore: python3 {out}/score.py ; python3 {out}/score.py --check {out}/SUMMARY.md")


if __name__ == "__main__":
    main()
