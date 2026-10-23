import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, D, Report } from "./lib.mjs";
import { runProc } from "./procz.mjs";
const dir = process.argv[2];
const r = new Report();
async function world() {
  const d = await mkdtemp(join(tmpdir(), "p2-"));
  process.env.STATE_DIR = d;
  return { d, m: await load(dir) };
}
const rs = (m, userId, iso, o = {}) => m.reserveEmail({ userId, kind: "marketing", timeZone: "America/New_York", now: D(iso), ...o });
const NOON = "2026-02-10T17:00:00Z"; // 12:00 in New York
await r.crit("1 fourth marketing email on one local day is refused", async (why) => {
  const { m } = await world();
  const res = [];
  for (let i = 0; i < 4; i++) res.push(await rs(m, "u1", `2026-02-10T${17 + i}:00:00Z`));
  const ok = res[0].allowed && res[1].allowed && res[2].allowed && res[3].allowed === false;
  if (!ok) why(JSON.stringify(res.map((x) => x.allowed)));
  const more = await rs(m, "u1", "2026-02-10T23:00:00Z");
  if (more.allowed !== false) why("fifth allowed");
  return ok && more.allowed === false;
});
await r.crit("2 allowance resets at the recipient's midnight, not UTC midnight", async (why) => {
  const { m } = await world();
  const tz = { timeZone: "America/Los_Angeles" };
  for (const t of ["2026-01-09T20:00:00Z", "2026-01-09T20:10:00Z", "2026-01-09T20:20:00Z"]) {
    const x = await rs(m, "u1", t, tz);
    if (!x.allowed) { why("first three not allowed"); return false; }
  }
  const late = await rs(m, "u1", "2026-01-10T07:30:00Z", tz); // 23:30 local Jan 9, UTC already Jan 10
  const next = await rs(m, "u1", "2026-01-10T08:30:00Z", tz); // 00:30 local Jan 10
  if (late.allowed !== false) why("23:30 local on the same local day was allowed");
  if (next.allowed !== true) why("00:30 local next day was refused");
  return late.allowed === false && next.allowed === true;
});
await r.crit("3 two worker processes at once cannot exceed the daily cap", async (why) => {
  const { d } = await world();
  const users = ["c1", "c2", "c3"];
  const plan = [];
  for (const u of users) for (let i = 0; i < 5; i++) plan.push({ fn: "reserveEmail", args: [{ userId: u, kind: "marketing", timeZone: "America/New_York", now: { $date: NOON } }] });
  const [a, b] = await Promise.all([runProc(dir, d, plan, true), runProc(dir, d, plan, true)]);
  let ok = true;
  for (const u of users) {
    const n = [...a, ...b].filter((x, i) => plan[i % plan.length].args[0].userId === u && x && x.allowed === true).length;
    if (n !== 3) { ok = false; why(u + " allowed " + n + " times"); }
  }
  return ok;
});
await r.crit("4 count survives a restart (new process sees earlier sends)", async (why) => {
  const { d } = await world();
  const send = { fn: "reserveEmail", args: [{ userId: "p1", kind: "marketing", timeZone: "Europe/Berlin", now: { $date: "2026-02-10T10:00:00Z" } }] };
  const first = await runProc(dir, d, [send, send]);
  const second = await runProc(dir, d, [send, send]);
  const ok = first[0].allowed && first[1].allowed && second[0].allowed === true && second[1].allowed === false;
  if (!ok) why(JSON.stringify([first, second].map((a) => a.map((x) => x.allowed))));
  return ok;
});
await r.crit("5 transactional email is neither blocked nor counted", async (why) => {
  const { m } = await world();
  for (let i = 0; i < 3; i++) await rs(m, "t1", `2026-02-10T${17 + i}:00:00Z`);
  const tx = await rs(m, "t1", "2026-02-10T21:00:00Z", { kind: "transactional" });
  if (tx.allowed !== true) why("transactional refused after quota");
  const { m: m2 } = await world();
  await rs(m2, "t2", "2026-02-10T17:00:00Z");
  await rs(m2, "t2", "2026-02-10T18:00:00Z");
  for (let i = 0; i < 5; i++) await rs(m2, "t2", `2026-02-10T${19 + (i % 3)}:00:00Z`, { kind: "transactional" });
  const third = await rs(m2, "t2", "2026-02-10T22:00:00Z");
  if (third.allowed !== true) why("transactional mail used up marketing allowance");
  return tx.allowed === true && third.allowed === true;
});
await r.crit("6 each person has their own allowance and refusals are named", async (why) => {
  const { m } = await world();
  for (let i = 0; i < 3; i++) await rs(m, "a", `2026-02-10T${17 + i}:00:00Z`);
  const denied = await rs(m, "a", "2026-02-10T21:00:00Z");
  const other = [];
  for (let i = 0; i < 3; i++) other.push(await rs(m, "b", `2026-02-10T${17 + i}:00:00Z`));
  const named = typeof denied.blockedBy === "string" && denied.blockedBy.length > 0;
  if (!named) why("blockedBy empty on refusal");
  const clean = other.every((x) => x.allowed === true && x.blockedBy == null);
  if (!clean) why("other user affected or blockedBy set on allow");
  return denied.allowed === false && named && clean;
});
r.print();
