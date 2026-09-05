# Contributing

proactive-gate decides whether a proactive AI agent may reach a user right now, and logs why not. Contributions are welcome, and small ones are the easiest to merge.

## Running the tests

```
npm ci
npm test        # tsc build, then node:test over dist/test/gate.test.js
```

Node 20 or newer and git are required. Note that Node 20's test runner does not expand glob patterns, so test files are named explicitly in `package.json`.

## Adding to the tool

To add a check: create a factory in `src/checks.ts` returning `{ id, run(ctx) }` (set `nonRejecting: true` if it may only adjust), add it to `defaultChecks()` only if it belongs in the default order, document it in the README table, and add a test in `test/gate.test.ts` that shows both the pass and the reject reason.

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
3. The `release` workflow runs the tests and publishes to npm with provenance (`npm publish --provenance`), so every published tarball is linked to the exact commit and workflow run that built it.

The workflow uses npm trusted publishing and holds no token. Before the first tagged release, the maintainer configures the trusted publisher on npmjs.com: package settings, Trusted publishing, GitHub Actions, repository `Bubblegunn/proactive-gate`, workflow `release.yml`.
