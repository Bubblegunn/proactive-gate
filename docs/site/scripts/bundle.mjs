// Bundles the TypeScript package for the browser pages. node:* stays external:
// SqliteStore resolves node:sqlite lazily and RedisStore takes a client, so nothing
// touches Node at import time.
//
// Two entry points, deliberately. `gate.js` is the package entry, which is what the
// playground evaluates one decision with. `sim.js` is `src/simulate.ts`, which the
// replay page needs and which the package does NOT export: widening `src/index.ts`
// to reach the browser would put the simulator in the published entry for every
// consumer, and the point of a second entry point is that the shipped surface stays
// exactly where it is. Nothing here changes what `npm pack` contains.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const common = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["node:*"],
  minify: true,
  logLevel: "info",
};

await build({ ...common, entryPoints: [`${here}../../../src/index.ts`], outfile: `${here}../public/playground/gate.js` });
await build({ ...common, entryPoints: [`${here}../../../src/simulate.ts`], outfile: `${here}../public/playground/sim.js` });
// The generated week the replay page starts from. Its own entry point rather than a
// re-export module outside src/, because tsconfig covers src/ and test/ only and a
// file here would ship to the browser untypechecked.
await build({ ...common, entryPoints: [`${here}../../../src/demo-week.ts`], outfile: `${here}../public/playground/demo.js` });
