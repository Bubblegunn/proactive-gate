import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/check-main-imports.mjs", import.meta.url));

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), "main-imports-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = { type: "module", exports: { ".": { import: "./dist/index.js" } } };
  for (const [name, content] of Object.entries({ "package.json": JSON.stringify(manifest), ...files })) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), content);
  }
  return root;
}

const run = (root) => spawnSync(process.execPath, ["--experimental-vm-modules", script, root], { encoding: "utf8" });

test("walks static imports and re-exports once, without executing code or following lazy imports", (t) => {
  const root = fixture(t, {
    "dist/index.js": 'export * from "./gate.js"; export * as store from "./store.js";',
    "dist/gate.js": 'import "./store.js"; throw new Error("must not execute");',
    "dist/store.js": `import "./gate.js";
      // import "node:fs";
      const example = 'export * from "node:path"';
      export const lazy = () => import("node:sqlite");`,
    "dist/unreachable.js": 'import "node:test";',
  });
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /3 files checked/);
});

for (const declaration of [
  'import "node:fs";',
  'import { readFile } from "node:fs";',
  'export * from "node:fs";',
  'export { readFile } from "node:fs";',
  'export * as fs from "node:fs";',
  'import "node:\\u0066s";',
  'import "fs";',
]) {
  test(`rejects a transitive builtin: ${declaration}`, (t) => {
    const root = fixture(t, {
      "dist/index.js": 'export * from "./gate.js";',
      "dist/gate.js": declaration,
    });
    const result = run(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /gate\.js -> (node:)?fs: Node builtin/);
  });
}

test("checks a side-effect import in the main entry", (t) => {
  const result = run(fixture(t, { "dist/index.js": 'import "node:fs";' }));
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /index\.js -> node:fs/);
});

test("fails rather than skipping a missing imported file", (t) => {
  const result = run(fixture(t, { "dist/index.js": 'export * from "./missing.js";' }));
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /ENOENT.*missing\.js/);
});

test("fails rather than skipping an external dependency", (t) => {
  const result = run(fixture(t, { "dist/index.js": 'import "external-package";' }));
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /cannot check an external static import/);
});

test("rejects a missing main import export", (t) => {
  const result = run(fixture(t, { "package.json": '{"main":"./index.js"}' }));
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /must declare a relative main import export/);
});

test("rejects malformed JavaScript instead of checking a partial graph", (t) => {
  const result = run(fixture(t, { "dist/index.js": 'export { from "./missing.js";' }));
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /files checked/);
});

test("does not follow static imports outside the packed package", (t) => {
  const root = fixture(t, {
    "package/package.json": '{"exports":{".":{"import":"./index.js"}}}',
    "package/index.js": 'export * from "../outside.js";',
    "outside.js": "export const outside = true;",
  });
  const result = run(join(root, "package"));
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /static import escapes the packed package/);
});
