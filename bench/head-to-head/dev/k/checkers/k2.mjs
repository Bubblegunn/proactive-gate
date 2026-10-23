import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, Report } from "./lib.mjs";
import { runProc } from "./procz.mjs";
process.env.TZ = "Pacific/Auckland";
const dir = process.argv[2];
const r = new Report();
const fresh = () => mkdtempSync(join(tmpdir(), "k2-"));
const NY = { id: "ny", timeZone: "America/New_York" };
const LA = { id: "la", timeZone: "America/Los_Angeles" };
let seq = 0;
// sequential in-process helper: list of [user, iso] -> array of allowed booleans
async function seqRun(items, why) {
  process.env.STATE_DIR = fresh();
  const bot = await load(dir);
  const out = [];
  for (const [u, iso, id] of items) {
    const x = await bot.reserve(u, id || "m" + ++seq, new Date(iso));
    if (!x || typeof x.allowed !== "boolean") { why("no boolean allowed"); return null; }
    if (!x.allowed && (typeof x.reason !== "string" || !x.reason.trim())) { why("empty reason on refusal"); return null; }
    out.push(x.allowed);
  }
  return out;
}
const same = (a, b) => a && a.length === b.length && a.every((v, i) => v === b[i]);
const T = true, F = false;
await r.crit("1 at most three per day, refusals carry a reason", async (why) => {
  const o = await seqRun([1, 2, 3, 4, 5].map(() => [NY, "2026-06-10T15:00:00Z"]), why);
  if (!same(o, [T, T, T, F, F])) { why("got " + JSON.stringify(o)); return false; }
  return true;
});
await r.crit("2 the day ends at the member's local midnight (not UTC, not 24h rolling)", async (why) => {
  const a = await seqRun([[NY, "2026-06-10T03:30:00Z"], [NY, "2026-06-10T03:40:00Z"], [NY, "2026-06-10T03:50:00Z"], [NY, "2026-06-10T04:05:00Z"]], why);
  if (!same(a, [T, T, T, T])) { why("NY across local midnight: " + JSON.stringify(a)); return false; }
  const b = await seqRun([[LA, "2026-06-09T23:30:00Z"], [LA, "2026-06-09T23:40:00Z"], [LA, "2026-06-09T23:50:00Z"], [LA, "2026-06-10T00:30:00Z"], [LA, "2026-06-10T08:00:00Z"]], why);
  if (!same(b, [T, T, T, F, T])) { why("LA across UTC midnight: " + JSON.stringify(b)); return false; }
  return true;
});
await r.crit("3 days on the clock-change dates last 25 and 23 hours (New York)", async (why) => {
  const a = await seqRun([[NY, "2026-11-01T04:30:00Z"], [NY, "2026-11-01T04:40:00Z"], [NY, "2026-11-01T04:50:00Z"], [NY, "2026-11-02T04:30:00Z"], [NY, "2026-11-02T05:05:00Z"]], why);
  if (!same(a, [T, T, T, F, T])) { why("fall-back day: " + JSON.stringify(a)); return false; }
  const b = await seqRun([[NY, "2026-03-08T05:10:00Z"], [NY, "2026-03-08T05:20:00Z"], [NY, "2026-03-08T05:30:00Z"], [NY, "2026-03-09T03:50:00Z"], [NY, "2026-03-09T04:10:00Z"]], why);
  if (!same(b, [T, T, T, F, T])) { why("spring-forward day: " + JSON.stringify(b)); return false; }
  return true;
});
await r.crit("4 four workers at the same moment never exceed three", async (why) => {
  const st = fresh();
  const now = { $date: "2026-06-10T15:00:00Z" };
  const plan = (p) => Array.from({ length: 5 }, (_, j) => [{ fn: "reserve", args: [NY, `p${p}-${j}`, now] }, { fn: "reserve", args: [LA, `q${p}-${j}`, now] }]).flat();
  const res = await Promise.all([0, 1, 2, 3].map((p) => runProc(dir, st, plan(p), true)));
  const flat = res.flat();
  const nyAllowed = flat.filter((x, i) => i % 2 === 0 && x && x.allowed === true).length;
  const laAllowed = flat.filter((x, i) => i % 2 === 1 && x && x.allowed === true).length;
  const errs = flat.filter((x) => x && x.error).length;
  if (errs) why(errs + " calls threw");
  if (nyAllowed !== 3 || laAllowed !== 3) { why(`allowed ny=${nyAllowed} la=${laAllowed}, want 3 and 3`); return false; }
  return errs === 0;
});
await r.crit("5 a redelivered messageId (even in another worker) is not counted twice", async (why) => {
  const st = fresh();
  const now = { $date: "2026-06-10T15:00:00Z" };
  const a = await runProc(dir, st, [{ fn: "reserve", args: [NY, "m1", now] }]);
  const b = await runProc(dir, st, ["m1", "m2", "m3", "m4", "m4"].map((id) => ({ fn: "reserve", args: [NY, id, now] })));
  const got = [a[0], ...b].map((x) => x && x.allowed);
  if (!same(got, [T, T, T, T, F, F])) { why("got " + JSON.stringify(got)); return false; }
  return true;
});
await r.crit("6 the count survives a restart and each member has their own", async (why) => {
  const st = fresh();
  const now = { $date: "2026-06-10T15:00:00Z" };
  const call = (u, id) => ({ fn: "reserve", args: [u, id, now] });
  const a = await runProc(dir, st, [call(NY, "a1"), call(NY, "a2")]);
  const b = await runProc(dir, st, [call(NY, "b1"), call(NY, "b2"), call(LA, "b3")]);
  const got = [...a, ...b].map((x) => x && x.allowed);
  if (!same(got, [T, T, T, F, T])) { why("got " + JSON.stringify(got)); return false; }
  return true;
});
r.print();
