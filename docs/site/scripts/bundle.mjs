// Bundles the TypeScript package for the browser playground. node:* stays external:
// SqliteStore resolves node:sqlite lazily and RedisStore takes a client, so nothing
// touches Node at import time.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
await build({
  entryPoints: [`${here}../../../src/index.ts`],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["node:*"],
  outfile: `${here}../public/playground/gate.js`,
  minify: true,
  logLevel: "info",
});
