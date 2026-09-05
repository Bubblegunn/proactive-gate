# Contributing

proactive-gate decides whether a proactive AI agent may reach a user right now, and logs why not. Contributions are welcome, and small ones are the easiest to merge.

## Running the tests

```
npm ci
npm test               # tsc build, spec-lint, then node:test over dist/test
cd python
pip install -e ".[dev]"
python -m mypy --strict src/proactive_gate tests && pytest
```

Node 20 or newer, Python 3.11 or newer, and git. Node 20's test runner does not expand glob patterns, so test files are named explicitly in `package.json`.

## Two implementations, one contract

`spec/SPEC.md` and the fixtures under `spec/fixtures` are the authority; the TypeScript and Python packages are both held to them in CI. A behaviour change therefore lands in three places: a fixture (or a new expectation in an existing one), the TypeScript check, and the Python check. If you can only do one language, open the pull request with the fixture and your language and say so; the other half is a small follow-up.

## Adding a check

TypeScript: a factory in `src/checks.ts` returning `{ id, run(ctx) }` (set `nonRejecting: true` if it may only adjust; add `consume(ctx)` if it is a budget), registered in `KNOWN_CHECKS` in `src/policy.ts` so JSON policies can name it.
Python: a class in `python/src/proactive_gate/checks.py` with `keys(ctx)` and `run(ctx, values)`, registered in `KNOWN_CHECKS` in `policy.py`.
Then a fixture under `spec/fixtures/<area>/<name>.json` with a pass and a reject case, a row in the README table, and `defaultChecks()` only if it belongs in the default order.

## Adding a preset

A preset is an ordered list of existing checks plus its sources and a note on what it leaves out. Add it to `src/presets.ts` and `python/src/proactive_gate/presets.py` with the same name, a fixture under `spec/fixtures/presets/`, and a row in the README table. Cite the page the numbers come from; when official sources disagree, pick the stricter documented value and say so in the note.

## Pull requests

- One change per pull request, with a test that fails before and passes after.
- Say in the description what a user sees differently; the template asks for it.
- Keep the package dependency-free unless the issue discussing the dependency was accepted first.
- No em dashes in shipped text (README, help, output). Plain sentences.
- Contributors are credited in the changelog entry for the release that ships their change.

## Releasing

Maintainers only.

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Commit, then `git tag vX.Y.Z && git push origin main --tags`.
3. The `release` workflow runs the tests and publishes to npm with provenance, so every published tarball is linked to the exact commit and workflow run that built it. The same run builds `python/dist` and publishes it to PyPI through the `pypi` environment.

Both publishes use trusted publishing and hold no token. Before the first tagged release the maintainer configures the trusted publisher on npmjs.com (package settings, Trusted publishing, GitHub Actions, repository `Bubblegunn/proactive-gate`, workflow `release.yml`) and on pypi.org (project `proactive-gate`, owner `Bubblegunn`, repository `proactive-gate`, workflow `release.yml`, environment `pypi`). Keep `version` in `package.json` and `python/pyproject.toml` equal.
