import { readFileSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SourceTextModule } from "node:vm";

try {
  if (process.argv.length !== 3) {
    throw new Error("usage: node --experimental-vm-modules scripts/check-main-imports.mjs <package-directory>");
  }
  const root = realpathSync(process.argv[2]);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const entry = manifest.exports?.["."]?.import;
  if (typeof entry !== "string" || !entry.startsWith("./")) {
    throw new Error("the packed package must declare a relative main import export");
  }
  const visited = new Set();

  function visit(url) {
    const file = realpathSync(fileURLToPath(url));
    const name = relative(root, file);
    if (name === ".." || name.startsWith(`..${sep}`) || isAbsolute(name)) {
      throw new Error(`static import escapes the packed package: ${file}`);
    }
    if (visited.has(file)) return;
    visited.add(file);
    // Parsing exposes static imports and re-exports without linking or executing the module.
    const parsed = new SourceTextModule(readFileSync(file, "utf8"), { identifier: file });
    const specifiers = parsed.moduleRequests?.map((request) => request.specifier) ?? parsed.dependencySpecifiers;
    for (const specifier of specifiers) {
      if (specifier.startsWith("node:") || isBuiltin(specifier)) {
        throw new Error(`${name} -> ${specifier}: Node builtin in the static main-entry graph`);
      }
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        throw new Error(`${name} -> ${specifier}: cannot check an external static import`);
      }
      visit(new URL(specifier, pathToFileURL(file)));
    }
  }

  visit(new URL(entry, pathToFileURL(`${root}${sep}`)));
  console.log(`main import graph: ${visited.size} files checked, no static Node builtins`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
