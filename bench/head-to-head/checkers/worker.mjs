// usage: node worker.mjs <botdir> <stateDir> <json plan>; plan = [{fn, args}] run concurrently; prints JSON results
import { load } from "./lib.mjs";
const [dir, state, planJson] = process.argv.slice(2);
process.env.STATE_DIR = state;
const bot = await load(dir);
const plan = JSON.parse(planJson);
const revive = (a) => JSON.parse(JSON.stringify(a), (k, v) => ((k === "now" || k === "until") && typeof v === "string" ? new Date(v) : v));
const one = async (p) => { try { return await bot[p.fn](revive(p.args)); } catch (e) { return { error: String(e.message || e) }; } };
let out;
if (process.env.CONC === "1") out = await Promise.all(plan.map(one));
else { out = []; for (const p of plan) out.push(await one(p)); }
console.log("RESULT" + JSON.stringify(out));
