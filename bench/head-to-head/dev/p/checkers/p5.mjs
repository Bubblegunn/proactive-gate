import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, D, Report } from "./lib.mjs";
import { runProc } from "./procz.mjs";
const dir = process.argv[2];
const r = new Report();
const NOW = "2026-02-10T10:00:00Z";
async function world() {
  const d = await mkdtemp(join(tmpdir(), "p5-"));
  process.env.STATE_DIR = d;
  return { d, m: await load(dir) };
}
const may = (m, email, kind) => m.mayEmail({ email, kind, now: D(NOW) });
await r.crit("1 unsubscribed address gets no marketing email; others unaffected", async (why) => {
  const { m } = await world();
  const before = await may(m, "ana@example.com", "marketing");
  await m.unsubscribe("ana@example.com", D(NOW));
  const after = await may(m, "ana@example.com", "marketing");
  const other = await may(m, "bob@example.com", "marketing");
  if (before.allowed !== true) why("blocked before unsubscribing");
  if (after.allowed !== false) why("still allowed after unsubscribe");
  if (other.allowed !== true) why("unrelated address blocked");
  return before.allowed === true && after.allowed === false && other.allowed === true;
});
await r.crit("2 capitals and stray spaces do not defeat an unsubscribe", async (why) => {
  const { m } = await world();
  await m.unsubscribe("  Ana.Smith@Example.COM ", D(NOW));
  let ok = true;
  for (const e of ["ana.smith@example.com", "ANA.SMITH@EXAMPLE.COM", " ana.smith@example.com  "]) {
    const x = await may(m, e, "marketing");
    if (x.allowed !== false) { ok = false; why("allowed for " + JSON.stringify(e)); }
  }
  const { m: m2 } = await world();
  await m2.recordBounce("Dead@Example.com", "hard", D(NOW));
  const y = await may(m2, "dead@example.com ", "transactional");
  if (y.allowed !== false) { ok = false; why("hard bounce not matched across case/space"); }
  return ok;
});
await r.crit("3 transactional email still allowed after unsubscribe", async (why) => {
  const { m } = await world();
  await m.unsubscribe("ana@example.com", D(NOW));
  const a = await may(m, "ana@example.com", "transactional");
  if (a.allowed !== true) why("password reset/receipt blocked after marketing unsubscribe");
  return a.allowed === true;
});
await r.crit("4 hard bounce stops all mail to the address, soft bounce stops none", async (why) => {
  const { m } = await world();
  await m.recordBounce("gone@example.com", "hard", D(NOW));
  await m.recordBounce("full@example.com", "soft", D(NOW));
  const h1 = await may(m, "gone@example.com", "marketing");
  const h2 = await may(m, "gone@example.com", "transactional");
  const s1 = await may(m, "full@example.com", "marketing");
  const s2 = await may(m, "full@example.com", "transactional");
  if (h1.allowed !== false || h2.allowed !== false) why("hard bounce did not stop both kinds");
  if (s1.allowed !== true || s2.allowed !== true) why("soft bounce suppressed the address");
  return h1.allowed === false && h2.allowed === false && s1.allowed === true && s2.allowed === true;
});
await r.crit("5 suppressions written in one process are seen by another and after restart", async (why) => {
  const { d } = await world();
  const t = { $date: NOW };
  await runProc(dir, d, [
    { fn: "unsubscribe", args: ["a@example.com", t] },
    { fn: "recordBounce", args: ["b@example.com", "hard", t] },
  ]);
  const res = await runProc(dir, d, [
    { fn: "mayEmail", args: [{ email: "a@example.com", kind: "marketing", now: t }] },
    { fn: "mayEmail", args: [{ email: "a@example.com", kind: "transactional", now: t }] },
    { fn: "mayEmail", args: [{ email: "b@example.com", kind: "transactional", now: t }] },
    { fn: "mayEmail", args: [{ email: "c@example.com", kind: "marketing", now: t }] },
  ]);
  const ok = res[0].allowed === false && res[1].allowed === true && res[2].allowed === false && res[3].allowed === true;
  if (!ok) why(JSON.stringify(res));
  return ok;
});
await r.crit("6 simultaneous unsubscribes from two workers are all kept", async (why) => {
  const { d } = await world();
  const t = { $date: NOW };
  const mk = (p) => Array.from({ length: 15 }, (_, i) => ({ fn: "unsubscribe", args: [`${p}${i}@example.com`, t] }));
  await Promise.all([runProc(dir, d, mk("u"), true), runProc(dir, d, mk("v"), true)]);
  const addrs = [...mk("u"), ...mk("v")].map((x) => x.args[0]);
  const plan = addrs.map((email) => ({ fn: "mayEmail", args: [{ email, kind: "marketing", now: t }] }));
  plan.push({ fn: "mayEmail", args: [{ email: "fresh@example.com", kind: "marketing", now: t }] });
  const res = await runProc(dir, d, plan);
  const lost = res.slice(0, addrs.length).filter((x) => !x || x.allowed !== false).length;
  if (lost) why(lost + " of " + addrs.length + " unsubscribes lost");
  const fresh = res[res.length - 1].allowed === true;
  if (!fresh) why("untouched address blocked");
  return lost === 0 && fresh;
});
r.print();
