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

`spec/CONFORMANCE.md` is the reader-facing half of this: what passing means field by field, how to declare a skip, and how a third implementation in any language claims a version. `npm run conformance-table` regenerates the README table from a real run of both implementations, and CI fails when the committed table is stale, so the table can never be a claim rather than a measurement.

### The spec version is tagged separately

`spec/SPEC_VERSION` moves on its own schedule, so it has its own tag series, `spec/vX.Y.Z`, distinct from the package's `vX.Y.Z` release tags. When a pull request changes `SPEC_VERSION`, the tag for the new version is pushed after it merges:

```sh
git tag spec/v1.2.0 -m "spec 1.2.0" && git push origin spec/v1.2.0
```

Maintainers only, because the ruleset restricts tag creation. An implementation pins that tag rather than a package release, which is what lets it target the contract without depending on npm or PyPI.

## Adding a check

TypeScript: a factory in `src/checks.ts` returning `{ id, run(ctx) }` (set `nonRejecting: true` if it may only adjust; add `consume(ctx)` if it is a budget), registered in `KNOWN_CHECKS` in `src/policy.ts` so JSON policies can name it.
Python: a class in `python/src/proactive_gate/checks.py` with `keys(ctx)` and `run(ctx, values)`, registered in `KNOWN_CHECKS` in `policy.py`.
Then a fixture under `spec/fixtures/<area>/<name>.json` with a pass and a reject case, a row in the README table, and `defaultChecks()` only if it belongs in the default order.

## Adding a preset

A preset is an ordered list of existing checks plus its sources and a note on what it leaves out. Add it to `src/presets.ts` and `python/src/proactive_gate/presets.py` with the same name, a fixture under `spec/fixtures/presets/`, and a row in the README table.

A preset is the most natural outside contribution here, and the bar is the sourcing rather than the code:

- Every restriction cites a primary source: the instrument, the article or section, and a URL. A secondary source describing a rule is not enough on its own, and where secondary sources disagree about a number, that disagreement is the reason to leave the number out rather than pick one.
- Two fixtures come with it, one allowing and one rejecting, under `spec/fixtures/presets/`, so both implementations are held to it.
- A regulatory preset binds a message only when the message is itself commercial. Most of these instruments regulate marketing, not the kind of assistant message this library gates, and the note must say which the preset is. Naming a preset after a law it does not actually implement would be the worst thing in this repository.

When official sources disagree, pick the stricter documented value and say so in the note.

## Pull requests

- One change per pull request, with a test that fails before and passes after.
- Say in the description what a user sees differently; the template asks for it.
- Keep the package dependency-free unless the issue discussing the dependency was accepted first.
- No em dashes in shipped text (README, help, output). Plain sentences.
- Contributors are credited in the changelog entry for the release that ships their change.

## Releasing

Maintainers only. One command; the workflow does the rest.

1. Write the `## X.Y.Z (unreleased)` entry in `CHANGELOG.md` and merge it.
2. On a clean, green `main`: `npm run release -- X.Y.Z` (or `patch`, `minor`, `major`; add `--dry-run` to see the plan). It dates the entry, sets the version in `package.json`, `CITATION.cff` and `python/pyproject.toml`, runs the tests, commits, tags `vX.Y.Z`, pushes, and then moves the major tag (`v0` today) to the release and force-pushes it, so anyone pinning a major follows the newest release in it. The major tag moves from this command and not from the workflow because release tags are admin-only by ruleset; a workflow token could not move it.
3. Watch the `release` workflow: it publishes to npm with provenance, builds and checks the Python package, creates the GitHub release from the CHANGELOG entry, and installs the published version from the registry on three operating systems.

CI runs `scripts/release-gate.mjs` on every push: the version must agree across those files and `npm pack` may ship only the paths in `scripts/pack-allowlist.txt` (regenerate with `node scripts/release-gate.mjs --update` when the package layout changes on purpose).

Publishing uses trusted publishing and holds no token. The npm publisher is configured on npmjs.com (package settings, Trusted publishing, GitHub Actions, repository `Bubblegunn/proactive-gate`, workflow `release.yml`, "Allow npm publish" ticked).

### Publishing the Python package

`publish-pypi` is skipped until the repository variable `PYPI_TRUSTED_PUBLISHER` is `true`, so a
release does not go red for a credential nobody in CI can supply. `build-python` still runs on every
release: mypy strict, the tests, `python -m build` and `twine check`.

0.2.1 is on PyPI, uploaded from a local build with a one-off token because a trusted publisher
cannot be configured for a project that does not exist yet. That release therefore carries no build
provenance, which the READMEs say; the npm package's provenance is unaffected. To move publishing
into the workflow, do these three in this order:

1. Add the trusted publisher on the existing project at
   <https://pypi.org/manage/project/proactive-gate/settings/publishing/>, with owner `Bubblegunn`,
   repository `proactive-gate`, workflow `release.yml`, environment `pypi`.
2. `gh variable set PYPI_TRUSTED_PUBLISHER --body true -R Bubblegunn/proactive-gate`.
3. Revoke the bootstrap token on PyPI.

The order matters: revoking the token before the publisher exists would leave no way to publish at
all. Every release prints the same instruction in its job summary.
