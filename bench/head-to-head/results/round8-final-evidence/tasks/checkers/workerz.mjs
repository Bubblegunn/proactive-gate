// Worker for the Z checkers (Z1 to Z3): runs a plan of bot calls in this process and prints RESULT<json>.
// usage: node workerz.mjs <botdir> <stateDir> <jsonPlan>
// jsonPlan = [{fn, args:[...]}]. Each args element is passed as one positional argument after recursive revival:
// any object of the form {"$date":"ISO"} becomes a Date, everything else is plain JSON.
// Calls run one after another, or all at once with Promise.all when env CONC=1. A call that throws or rejects
// yields {error}. Results are JSON-encoded in plan order (undefined becomes null).
import { load } from "./lib.mjs";

const [dir, state, planJson] = process.argv.slice(2);
process.env.STATE_DIR = state;
const bot = await load(dir);
const plan = JSON.parse(planJson);

function revive(v) {
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === "object") {
    if (Object.keys(v).length === 1 && typeof v.$date === "string") return new Date(v.$date);
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = revive(x);
    return out;
  }
  return v;
}

async function one(p) {
  try {
    const r = await bot[p.fn](...revive(p.args));
    return r === undefined ? null : r;
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 300) };
  }
}

let out;
if (process.env.CONC === "1") {
  out = await Promise.all(plan.map(one));
} else {
  out = [];
  for (const p of plan) out.push(await one(p));
}
console.log("RESULT" + JSON.stringify(out));
