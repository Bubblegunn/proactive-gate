import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, Report } from "./lib.mjs";
import { runProc } from "./procz.mjs";
const dir = process.argv[2];
const r = new Report();
const T0 = Date.parse("2026-02-02T08:00:00Z");
const M = 60e3, H = 3600e3, DAY = 24 * H;
const at = (ms) => new Date(T0 + ms);
async function world() {
  const d = await mkdtemp(join(tmpdir(), "p4-"));
  process.env.STATE_DIR = d;
  return { d, m: await load(dir) };
}
const req = (m, ms, u = "u1") => m.requestSend({ userId: u, now: at(ms) });
// builds a fresh world, makes the sends (all must be allowed), then asks at askMs
async function scenario(sends, askMs) {
  const { m } = await world();
  for (const s of sends) {
    const x = await req(m, s);
    if (!x.allowed) throw new Error("setup send refused at " + s);
  }
  return req(m, askMs);
}
// the retryAt a refusal reports must be (about) the first moment a request is accepted
async function retryIsHonest(sends, askMs, why, label) {
  const first = await scenario(sends, askMs);
  if (first.allowed !== false || typeof first.retryAt !== "string" || Number.isNaN(Date.parse(first.retryAt))) { why(label + ": no valid retryAt " + JSON.stringify(first)); return false; }
  const ra = Date.parse(first.retryAt) - T0;
  const after = await scenario(sends, ra + M);
  const before = await scenario(sends, ra - M);
  if (after.allowed !== true) why(label + ": still refused one minute after retryAt");
  if (before.allowed !== false) why(label + ": allowed one minute before retryAt");
  return after.allowed === true && before.allowed === false;
}
await r.crit("1 two-hour gap enforced; refused attempts do not extend it", async (why) => {
  const { m } = await world();
  const a = await req(m, 0), b = await req(m, 30 * M), c = await req(m, 119 * M), d = await req(m, 121 * M);
  const res = [a.allowed, b.allowed, c.allowed, d.allowed];
  const ok = JSON.stringify(res) === JSON.stringify([true, false, false, true]);
  if (!ok) why(JSON.stringify(res));
  return ok;
});
await r.crit("2 fifth contact in a rolling seven days refused, then allowed once the oldest ages out; limit is named", async (why) => {
  const { m } = await world();
  const sends = [0, DAY, 2 * DAY, 3 * DAY];
  for (const s of sends) if (!(await req(m, s)).allowed) { why("first four refused at " + s); return false; }
  const day4 = await req(m, 4 * DAY);
  const day6 = await req(m, 6 * DAY + 23 * H);
  const day7 = await req(m, 7 * DAY + M);
  if (day4.allowed !== false) why("fifth contact on day 4 allowed");
  if (day6.allowed !== false) why("allowed on day 6 23:00");
  if (day7.allowed !== true) why("refused at day 7 plus a minute");
  const gap = await scenario([0], H);
  const named = typeof day4.blockedBy === "string" && day4.blockedBy.length > 0 && typeof gap.blockedBy === "string" && gap.blockedBy.length > 0 && day4.blockedBy !== gap.blockedBy;
  if (!named) why("blockedBy weekly=" + day4.blockedBy + " gap=" + gap.blockedBy);
  return day4.allowed === false && day6.allowed === false && day7.allowed === true && named;
});
await r.crit("3 retryAt after a gap refusal is the first moment a request passes", async (why) => {
  return retryIsHonest([0], 45 * M, why, "gap");
});
await r.crit("4 retryAt after a weekly-cap refusal (also when the gap applies too) satisfies both limits", async (why) => {
  const sends = [0, DAY, 2 * DAY, 3 * DAY];
  const a = await retryIsHonest(sends, 4 * DAY, why, "weekly only");
  const b = await retryIsHonest(sends, 3 * DAY + H, why, "weekly and gap");
  return a && b;
});
await r.crit("5 workers asking at the same moment cannot both get the slot", async (why) => {
  const { d } = await world();
  const users = ["x1", "x2", "x3"];
  const plan = [];
  for (const u of users) for (let i = 0; i < 4; i++) plan.push({ fn: "requestSend", args: [{ userId: u, now: { $date: "2026-02-02T08:00:00Z" } }] });
  const [a, b] = await Promise.all([runProc(dir, d, plan, true), runProc(dir, d, plan, true)]);
  let ok = true;
  for (const u of users) {
    const n = [...a, ...b].filter((x, i) => plan[i % plan.length].args[0].userId === u && x && x.allowed === true).length;
    if (n !== 1) { ok = false; why(u + " got " + n + " slots"); }
  }
  return ok;
});
await r.crit("6 earlier sends from other (restarted) processes are remembered", async (why) => {
  const { d } = await world();
  const one = (userId, ms) => [{ fn: "requestSend", args: [{ userId, now: { $date: new Date(T0 + ms).toISOString() } }] }];
  let ok = true;
  for (let i = 0; i < 4; i++) {
    const res = (await runProc(dir, d, one("w1", i * DAY)))[0];
    if (!res || res.allowed !== true) { ok = false; why("send " + i + " refused"); }
  }
  const fifth = (await runProc(dir, d, one("w1", 4 * DAY)))[0];
  if (!fifth || fifth.allowed !== false) { ok = false; why("fifth in a new process allowed"); }
  await runProc(dir, d, one("w2", 0));
  const gap = (await runProc(dir, d, one("w2", 30 * M)))[0];
  if (!gap || gap.allowed !== false) { ok = false; why("gap not enforced across processes"); }
  return ok;
});
r.print();
