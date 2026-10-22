# Your job: write 5 benchmark tasks (ids g1 to g5)

You work only inside this folder (/tmp/r5/writer). Do not read, list or search any other folder on this machine, and do not
use the network. If you need a fact, say in TASKS.md that it is from memory.

## The user problem the tasks come from

> "My AI agent messages people at night and past their daily limit, and I cannot tell which rule should have stopped it."

A developer builds an app or an AI agent that proactively messages end users (push, SMS, email, in-app) without being
asked. They need the code that decides, for each candidate message, whether it may go out now, and that keeps
the state needed for that decision. Real products and real rules apply (platform guidelines, telephone and email law,
common engineering practice). You decide which situations to cover. Pick 5 different realistic situations a developer
would bring to a coding assistant. Mix single-process and several-worker-processes cases, stateless and stateful cases.

## What a task is

A coding agent is given only the prompt text, in an empty folder, with Node 22 (ES modules). It writes `bot.mjs` there, which exports the
functions the prompt names. The agent does not see your checker.

Prompt rules (file `out/prompts/gN.txt`, one paragraph or a few, 1300 to 2400 characters, plain English, written like a real developer request):
- State the product situation, the data the app hands over (field names, types, formats, time zone names, who holds which clock), and the exact exported
  function names and shapes (arguments, return values). `now` is always passed in as a Date when time matters.
- When several worker processes share state, say they share the directory named by the environment variable STATE_DIR
  (state must survive a restart) and that the agent may create it. Do not say when STATE_DIR is set.
- Do NOT name any library, tool, plugin or skill. Do NOT list the rules. Each rule is something a careful reader would infer from the
  product need or from a regulation or platform document you cite.
- End with: "Do not actually send anything. Check that it works before you finish."

## Checkers

File `out/checkers/gN.mjs`, run as `node gN.mjs <folder containing bot.mjs>`. It loads the agent's code with `load` from `./lib.mjs`, runs it with injected
users, clocks and state (fresh temp STATE_DIR per case; set `process.env.STATE_DIR` before calling), and prints with the `Report` class from
`./lib.mjs`: each criterion is `await r.crit("N short title", async (why) => boolean)` and at the end `r.print()`. Exactly 6 criteria per
task, numbered `1` to `6` at the start of the name. Multi-process cases may use `runProc` from `./procz.mjs` (it runs `workerz.mjs`). Copy
`lib.mjs`, `procz.mjs`, `workerz.mjs` from this folder into `out/checkers/`. Checkers must be deterministic, finish in under 60 seconds, and
accept any reasonable implementation: do not require one exact wording, one file layout or one extra export; test behaviour that the prompt
makes observable. Every criterion tests one requirement and decides it from the code's observable behaviour.

Validation (required): for each task write a correct reference `out/ref/gN-good/bot.mjs` and two plausible broken ones
`out/ref/gN-broken-a/bot.mjs`, `gN-broken-b/bot.mjs` that fail different criteria. The good one must pass 6 of 6; each broken one must fail
the criteria you intended. Run them and record the result in TASKS.md. Fix the checker, not the expectations, when a correct
alternative implementation would fail.

## Labels

File `out/labels.json`: `{"g1": {"1": {"label": "outcome", "why": "...", "concern": "..."}, "2": {...}, ...}, "g2": {...}}`. Every
criterion is labelled "outcome" (what the end user or the message recipient receives or is protected from).
"why" says what is checked; "concern" says honestly how a correct implementation could still fail the check.

## TASKS.md

For each task: the situation in one sentence, the 6 criteria with a source for each (regulation, platform document or "engineering rationale"),
the validation result. Do not guess how any tool would do on the tasks. The tasks are not tuned against any tool.

## Output layout

`out/prompts/g1.txt` ... `g5.txt`, `out/checkers/` (g1.mjs ... g5.mjs, lib.mjs, procz.mjs, workerz.mjs), `out/fixtures/` (only if a task needs a
file the agent starts with; usually empty), `out/ref/`, `out/labels.json`, `out/TASKS.md`. When done, print the single line `DONE` and a one-line list of files.
