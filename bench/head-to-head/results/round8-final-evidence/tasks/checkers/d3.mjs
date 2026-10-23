process.env.TZ = "UTC";
import { Report } from "./lib.mjs";
import { runProc } from "./procz.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = process.argv[2];
const r = new Report();
const fresh = () => join(mkdtempSync(join(tmpdir(), "d3-")), "state", "inner"); // does not exist yet
const call = (userId, timeZone, channel, iso) => ({ fn: "reserve", args: [{ userId, timeZone, channel, now: { $date: iso } }] });
const allowedCount = (res) => res.filter((x) => x && x.allowed === true).length;
const T = "2026-06-10T10:00:00Z";

await r.crit("1 a customer gets two marketing messages a day, the third is held with a rule", async (why) => {
  const st = fresh();
  const res = await runProc(dir, st, [call("u", "Europe/Berlin", "sms", T), call("u", "Europe/Berlin", "sms", T), call("u", "Europe/Berlin", "sms", T)]);
  if (res[0]?.allowed !== true || res[1]?.allowed !== true) { why(JSON.stringify(res)); return false; }
  if (res[2]?.allowed !== false || typeof res[2].rule !== "string" || !res[2].rule) { why("third: " + JSON.stringify(res[2])); return false; }
  return true;
});
await r.crit("2 the count survives a restart (new process sees earlier messages)", async (why) => {
  const st = fresh();
  await runProc(dir, st, [call("u", "Europe/Berlin", "sms", T), call("u", "Europe/Berlin", "sms", T)]);
  const res = await runProc(dir, st, [call("u", "Europe/Berlin", "sms", T)]);
  if (res[0]?.allowed !== false) { why(JSON.stringify(res)); return false; }
  return true;
});
await r.crit("3 eight simultaneous requests in one process admit exactly two", async (why) => {
  const st = fresh();
  const res = await runProc(dir, st, Array.from({ length: 8 }, () => call("u", "Europe/Berlin", "push", T)), true);
  const n = allowedCount(res);
  if (n !== 2) { why("allowed " + n + " " + JSON.stringify(res).slice(0, 200)); return false; }
  return true;
});
await r.crit("4 requests from four processes at once admit exactly two per customer", async (why) => {
  const st = fresh();
  const users = ["a", "b", "c"];
  const plan = () => users.flatMap((u) => [call(u, "Europe/Berlin", "email", T), call(u, "Europe/Berlin", "email", T)]);
  const all = await Promise.all([1, 2, 3, 4].map(() => runProc(dir, st, plan(), true)));
  const flat = all.flat();
  for (let i = 0; i < users.length; i++) {
    const mine = all.flatMap((res) => res.filter((_, j) => Math.floor(j / 2) === i));
    const n = allowedCount(mine);
    if (n !== 2) { why(`user ${users[i]} allowed ${n}; errors: ${JSON.stringify(flat.filter((x) => x && x.error).slice(0, 1))}`); return false; }
  }
  return true;
});
await r.crit("5 channels count together, customers count separately", async (why) => {
  const st = fresh();
  const res = await runProc(dir, st, [
    call("u", "Europe/Berlin", "sms", T), call("u", "Europe/Berlin", "email", T),
    call("u", "Europe/Berlin", "push", T), call("v", "Europe/Berlin", "push", T),
  ]);
  if (res[0]?.allowed !== true || res[1]?.allowed !== true || res[2]?.allowed !== false || res[3]?.allowed !== true) { why(JSON.stringify(res)); return false; }
  return true;
});
await r.crit("6 the day is the customer's local day and resets after midnight there", async (why) => {
  const st = fresh();
  const tz = "Asia/Tokyo";
  await runProc(dir, st, [call("t", tz, "sms", "2026-06-10T13:00:00Z"), call("t", tz, "email", "2026-06-10T14:00:00Z")]);
  const res = await runProc(dir, st, [call("t", tz, "push", "2026-06-10T14:30:00Z")]);
  if (res[0]?.allowed !== false) { why("23:30 local same day allowed: " + JSON.stringify(res)); return false; }
  const res2 = await runProc(dir, st, [call("t", tz, "push", "2026-06-10T15:10:00Z")]);
  if (res2[0]?.allowed !== true) { why("00:10 local next day blocked: " + JSON.stringify(res2)); return false; }
  return true;
});
r.print();
