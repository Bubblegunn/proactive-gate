import { Report } from "./lib.mjs";
import { runProc } from "./procz.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const dir = resolve(process.argv[2]);
const r = new Report();
const $d = (iso) => ({ $date: iso });
const fresh = () => join(mkdtempSync(join(tmpdir(), "g4-")), "state");
const req = (userId, o = {}) => ({ userId, maxPerWindow: 3, windowHours: 24, minGapMinutes: 0, ...o });
const rsv = (userId, iso, o) => ({ fn: "reserve", args: [req(userId, o), $d(iso)] });
const rel = (id) => ({ fn: "release", args: [id] });
const yes = (x) => x && x.allowed === true && typeof x.reservationId === "string" && x.reservationId.length > 0;
const no = (x) => x && x.allowed === false && typeof x.reason === "string" && x.reason.length > 0 && !x.reservationId;

await r.crit("1 simultaneous reservations from several processes never exceed the cap", async (why) => {
  const s = fresh();
  const plan = [];
  for (let i = 0; i < 5; i++) { plan.push(rsv("lead_1", "2026-03-02T10:00:00Z")); plan.push(rsv("lead_2", "2026-03-02T10:00:00Z")); }
  const outs = await Promise.all([0, 1, 2, 3].map(() => runProc(dir, s, plan, true)));
  const flat = outs.flat();
  const bad = flat.find((x) => !x || (x.error));
  if (bad) { why(JSON.stringify(bad)); return false; }
  const n1 = flat.filter((x, i) => i % 2 === 0 && x.allowed).length;
  const n2 = flat.filter((x, i) => i % 2 === 1 && x.allowed).length;
  if (n1 !== 3 || n2 !== 3) { why(`allowed lead_1=${n1} lead_2=${n2}, expected 3 and 3`); return false; }
  return true;
});
await r.crit("2 the window slides with each message instead of resetting at a fixed time", async (why) => {
  const s = fresh();
  const o = { maxPerWindow: 2 };
  const res = await runProc(dir, s, [
    rsv("l", "2026-03-02T08:00:00Z", o), rsv("l", "2026-03-02T20:00:00Z", o),
    rsv("l", "2026-03-03T00:30:00Z", o), // new calendar day (UTC) but 2 sends in the last 24h
    rsv("l", "2026-03-03T07:59:00Z", o), // first send is 23h59m old
    rsv("l", "2026-03-03T08:01:00Z", o), // first send has aged out, second has not
    rsv("l", "2026-03-03T08:02:00Z", o),
  ]);
  const exp = [yes, yes, no, no, yes, no];
  for (let i = 0; i < exp.length; i++) if (!exp[i](res[i])) { why(`step ${i}: ${JSON.stringify(res[i])}`); return false; }
  return true;
});
await r.crit("3 the minimum gap between messages is enforced and ends on time", async (why) => {
  const s = fresh();
  const o = { maxPerWindow: 10, minGapMinutes: 120 };
  const res = await runProc(dir, s, [rsv("l", "2026-03-02T10:00:00Z", o), rsv("l", "2026-03-02T11:59:00Z", o), rsv("l", "2026-03-02T12:01:00Z", o), rsv("m", "2026-03-02T12:02:00Z", o)]);
  const exp = [yes, no, yes, yes];
  for (let i = 0; i < exp.length; i++) if (!exp[i](res[i])) { why(`step ${i}: ${JSON.stringify(res[i])}`); return false; }
  if (res[1].reason === undefined) return false;
  return true;
});
await r.crit("4 a refused attempt is not counted and does not restart the gap or window", async (why) => {
  const s = fresh();
  const g = { maxPerWindow: 10, minGapMinutes: 60 };
  const a = await runProc(dir, s, [rsv("l", "2026-03-02T10:00:00Z", g), rsv("l", "2026-03-02T10:30:00Z", g), rsv("l", "2026-03-02T11:01:00Z", g)]);
  if (!yes(a[0]) || !no(a[1]) || !yes(a[2])) { why("gap: " + JSON.stringify(a)); return false; }
  const w = { maxPerWindow: 2 };
  const b = await runProc(dir, fresh(), [
    rsv("w", "2026-03-02T09:00:00Z", w), rsv("w", "2026-03-02T09:30:00Z", w),
    rsv("w", "2026-03-02T10:00:00Z", w), rsv("w", "2026-03-02T11:00:00Z", w), rsv("w", "2026-03-02T12:00:00Z", w),
    rsv("w", "2026-03-03T09:01:00Z", w), // first aged out; refused attempts must not fill the window
  ]);
  const exp = [yes, yes, no, no, no, yes];
  for (let i = 0; i < exp.length; i++) if (!exp[i](b[i])) { why(`window step ${i}: ${JSON.stringify(b[i])}`); return false; }
  return true;
});
await r.crit("5 history survives restarts and is shared: a new process sees earlier sends, other state dirs are separate", async (why) => {
  const s = fresh();
  await runProc(dir, s, [rsv("l", "2026-03-02T10:00:00Z"), rsv("l", "2026-03-02T10:05:00Z")]);
  await runProc(dir, s, [rsv("l", "2026-03-02T10:10:00Z")]);
  const [a] = await runProc(dir, s, [rsv("l", "2026-03-02T10:15:00Z")]);
  const [b] = await runProc(dir, fresh(), [rsv("l", "2026-03-02T10:15:00Z")]);
  if (!no(a) || !yes(b)) { why(JSON.stringify([a, b])); return false; }
  return true;
});
await r.crit("6 release from another process gives the slot back, once", async (why) => {
  const s = fresh();
  const o = { maxPerWindow: 2 };
  const [x, y, z] = await runProc(dir, s, [rsv("l", "2026-03-02T10:00:00Z", o), rsv("l", "2026-03-02T10:05:00Z", o), rsv("l", "2026-03-02T10:06:00Z", o)]);
  if (!yes(x) || !yes(y) || !no(z)) { why(JSON.stringify([x, y, z])); return false; }
  await runProc(dir, s, [rel(x.reservationId), rel(x.reservationId)]);
  const res = await runProc(dir, s, [rsv("l", "2026-03-02T10:07:00Z", o), rsv("l", "2026-03-02T10:08:00Z", o)]);
  if (!yes(res[0]) || !no(res[1])) { why(JSON.stringify(res)); return false; }
  return true;
});
r.print();
