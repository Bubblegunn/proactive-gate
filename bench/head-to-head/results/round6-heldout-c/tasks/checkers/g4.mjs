import { Report } from "./lib.mjs";
import { runProc } from "./procz.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = process.argv[2];
const r = new Report();
const tmp = () => mkdtempSync(join(tmpdir(), "g4-"));
const T = (iso) => Date.parse(iso);
const call = (u, ch, iso) => ({ fn: "reserve", args: [u, ch, { $date: iso }] });
// five sends in the evening, then probes
const EVE = ["2026-06-01T20:00:00Z", "2026-06-01T20:30:00Z", "2026-06-01T21:00:00Z", "2026-06-01T21:30:00Z", "2026-06-01T22:00:00Z"];
const sends = (u) => EVE.map((t, i) => call(u, ["sms", "push", "chat"][i % 3], t));

await r.crit("1 sixth message in 24 hours is refused across processes and channels, other customers unaffected", async (why) => {
  const s = tmp();
  const got = [];
  for (const p of sends("A")) got.push((await runProc(dir, s, [p]))[0]);
  const [six] = await runProc(dir, s, [call("A", "sms", "2026-06-01T23:00:00Z")]);
  const [b] = await runProc(dir, s, [call("B", "sms", "2026-06-01T23:00:00Z")]);
  why(JSON.stringify([got.map((x) => x.allowed), six, b.allowed]));
  return got.every((x) => x.allowed === true && x.retryAt == null) && six.allowed === false && typeof six.reason === "string" && six.reason.length > 3 && b.allowed === true;
});
await r.crit("2 workers racing for the same customer never let more than 5 through", async (why) => {
  const s = tmp();
  const plan = Array.from({ length: 4 }, () => call("A", "push", "2026-06-01T20:00:00Z"));
  const res = (await Promise.all([0, 1, 2, 3].map(() => runProc(dir, s, plan, true)))).flat();
  const n = res.filter((x) => x.allowed === true).length;
  const errs = res.filter((x) => x.error).length;
  why(`allowed ${n} of ${res.length}, errors ${errs}`);
  return n === 5 && errs === 0;
});
await r.crit("3 the 24 hours slide with the clock, not with the calendar day", async (why) => {
  const s = tmp();
  const res = await runProc(dir, s, [...sends("A"), call("A", "sms", "2026-06-02T00:30:00Z"), call("A", "sms", "2026-06-02T19:59:00Z")]);
  why(JSON.stringify(res.map((x) => x.allowed)));
  return res.slice(0, 5).every((x) => x.allowed) && res[5].allowed === false && res[6].allowed === false;
});
await r.crit("4 retryAt for a refused message is when the oldest counted message ages out", async (why) => {
  const s = tmp();
  const res = await runProc(dir, s, [...sends("A"), call("A", "sms", "2026-06-01T23:00:00Z")]);
  const d = res[5];
  why(JSON.stringify(d));
  const t = T(d.retryAt);
  // exact moment, with a few seconds of slack for implementations that add a safety margin
  return d.allowed === false && t >= T("2026-06-02T20:00:00Z") && t <= T("2026-06-02T20:00:05Z");
});
await r.crit("5 refused attempts are not counted, and the window frees one slot at a time", async (why) => {
  const s = tmp();
  const denials = ["2026-06-01T23:00:00Z", "2026-06-02T01:00:00Z", "2026-06-02T08:00:00Z", "2026-06-02T12:00:00Z", "2026-06-02T18:00:00Z"].map((t) => call("A", "sms", t));
  const res = await runProc(dir, s, [...sends("A"), ...denials, call("A", "sms", "2026-06-02T20:00:01Z"), call("A", "sms", "2026-06-02T20:00:02Z"), call("A", "sms", "2026-06-02T20:30:01Z")]);
  const al = res.map((x) => x.allowed);
  why(JSON.stringify(al));
  // one slot (the 20:00 message) is free at 20:00:01; the 20:30 message ages out later
  return al.slice(5, 10).every((x) => x === false) && al[10] === true && al[11] === false && al[12] === true;
});
await r.crit("6 a state directory that does not exist yet is created and shared by later processes", async (why) => {
  const s = join(tmp(), "a", "b", "state");
  const got = [];
  for (const p of sends("A")) got.push((await runProc(dir, s, [p]))[0]);
  const [six] = await runProc(dir, s, [call("A", "sms", "2026-06-01T23:00:00Z")]);
  why(JSON.stringify([got.map((x) => x.allowed || x.error), six]));
  return got.every((x) => x.allowed === true) && six.allowed === false;
});
r.print();
