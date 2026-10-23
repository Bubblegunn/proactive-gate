import { load, Report } from "./lib.mjs";
import { runProc } from "./procz.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = process.argv[2];
const fresh = () => join(mkdtempSync(join(tmpdir(), "r2-")), "state");
async function inproc() {
  process.env.STATE_DIR = fresh();
  const bot = await load(dir);
  return (userId, tz, iso, category = "promotional") => bot.reservePush({ userId, timeZone: tz, now: new Date(iso), category });
}
const call = (userId, tz, iso, category = "promotional") => ({ fn: "reservePush", args: [{ userId, timeZone: tz, now: { $date: iso }, category }] });
const n = (res) => res.filter((x) => x && x.allowed === true).length;
const r = new Report();
await r.crit("1 at most 3 promotional pushes per user per day", async (why) => {
  const rp = await inproc();
  const res = [];
  for (let i = 0; i < 5; i++) res.push(await rp("a", "America/New_York", `2026-06-10T1${i}:00:00Z`));
  const ok = res.slice(0, 3).every((x) => x.allowed === true) && res.slice(3).every((x) => x.allowed === false) && res.every((x) => typeof x.rule === "string" && x.rule);
  if (!ok) why(JSON.stringify(res));
  return ok;
});
await r.crit("2 a day is the user's local calendar day", async (why) => {
  const rp = await inproc();
  const tk = "Asia/Tokyo";
  const a = [await rp("a", tk, "2026-06-09T15:30:00Z"), await rp("a", tk, "2026-06-09T16:00:00Z"), await rp("a", tk, "2026-06-10T14:00:00Z"), await rp("a", tk, "2026-06-10T14:30:00Z"),
    await rp("a", tk, "2026-06-10T15:01:00Z")]; // 00:01 JST on the 11th: a new day
  const la = "America/Los_Angeles";
  const b = [await rp("b", la, "2026-06-09T23:00:00Z"), await rp("b", la, "2026-06-10T01:00:00Z"), await rp("b", la, "2026-06-10T06:50:00Z"), await rp("b", la, "2026-06-10T06:55:00Z"),
    await rp("b", la, "2026-06-10T07:05:00Z")]; // local day of 9 June ends at 07:00Z; the 5th call is 00:05 on the 10th
  const okA = [true, true, true, false, true].every((v, i) => a[i].allowed === v);
  const okB = [true, true, true, false, true].every((v, i) => b[i].allowed === v);
  if (!(okA && okB)) why("tokyo " + a.map((x) => x.allowed) + " la " + b.map((x) => x.allowed));
  return okA && okB;
});
await r.crit("3 concurrent workers never exceed the limit", async (why) => {
  const st = fresh();
  const plan = [];
  for (let i = 0; i < 6; i++) plan.push(call("c", "Europe/Berlin", `2026-06-10T10:0${i}:00Z`));
  const outs = await Promise.all([runProc(dir, st, plan, true), runProc(dir, st, plan, true), runProc(dir, st, plan, true)]);
  const total = outs.reduce((s, o) => s + n(o), 0);
  if (total !== 3) why("allowed in total: " + total);
  return total === 3;
});
await r.crit("4 the count survives a process restart", async (why) => {
  const st = fresh();
  const p1 = await runProc(dir, st, [call("d", "Asia/Kolkata", "2026-06-10T05:00:00Z"), call("d", "Asia/Kolkata", "2026-06-10T05:01:00Z")]);
  const p2 = await runProc(dir, st, [call("d", "Asia/Kolkata", "2026-06-10T06:00:00Z"), call("d", "Asia/Kolkata", "2026-06-10T06:01:00Z"), call("d", "Asia/Kolkata", "2026-06-10T06:02:00Z")]);
  const ok = n(p1) === 2 && p2[0].allowed === true && p2[1].allowed === false && p2[2].allowed === false;
  if (!ok) why(JSON.stringify([p1, p2]));
  return ok;
});
await r.crit("5 transactional pushes are never refused and never counted", async (why) => {
  const rp = await inproc();
  for (let i = 0; i < 3; i++) await rp("e", "UTC", `2026-06-10T1${i}:00:00Z`);
  const t = [];
  for (let i = 0; i < 5; i++) t.push(await rp("e", "UTC", `2026-06-10T1${i}:30:00Z`, "transactional"));
  const rp2 = await inproc();
  for (let i = 0; i < 5; i++) await rp2("f", "UTC", `2026-06-10T1${i}:30:00Z`, "transactional");
  const p = [];
  for (let i = 0; i < 4; i++) p.push(await rp2("f", "UTC", `2026-06-10T2${i}:00:00Z`));
  const ok = t.every((x) => x.allowed === true) && p[0].allowed && p[1].allowed && p[2].allowed && p[3].allowed === false;
  if (!ok) why(JSON.stringify([t.map((x) => x.allowed), p.map((x) => x.allowed)]));
  return ok;
});
await r.crit("6 each user has their own count", async (why) => {
  const rp = await inproc();
  for (let i = 0; i < 3; i++) await rp("g1", "UTC", `2026-06-10T1${i}:00:00Z`);
  const a = await rp("g1", "UTC", "2026-06-10T15:00:00Z");
  const b = [await rp("g2", "UTC", "2026-06-10T15:00:00Z"), await rp("g3", "UTC", "2026-06-10T15:00:00Z"), await rp("g2", "UTC", "2026-06-10T15:01:00Z")];
  const ok = a.allowed === false && b.every((x) => x.allowed === true);
  if (!ok) why(JSON.stringify([a, b]));
  return ok;
});
r.print();
