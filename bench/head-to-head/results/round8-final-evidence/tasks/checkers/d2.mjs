process.env.TZ = "UTC";
import { load, Report } from "./lib.mjs";
const dir = process.argv[2];
const r = new Report();
const mod = async () => (await load(dir)).createGate();
const B = "Europe/Berlin", LA = "America/Los_Angeles";
const rq = (g, userId, timeZone, iso, category = "promo") => g.request({ userId, timeZone, category, now: new Date(iso) });
const ok = (x) => !!x && x.allowed === true;
const no = (x) => !!x && x.allowed === false;
const D = "2026-06-10T";

await r.crit("1 a customer gets three promos a day, the fourth is held, other customers are unaffected", async (why) => {
  const g = await mod();
  for (const h of ["08", "10", "12"]) if (!ok(rq(g, "a", B, `${D}${h}:00:00Z`))) { why("promo at " + h + " not allowed"); return false; }
  if (!no(rq(g, "a", B, `${D}14:00:00Z`))) { why("fourth promo allowed"); return false; }
  if (!ok(rq(g, "b", B, `${D}14:00:00Z`))) { why("other customer blocked"); return false; }
  return true;
});
await r.crit("2 two promos need two hours between them, blocked attempts do not move the gap", async (why) => {
  const g = await mod();
  if (!ok(rq(g, "c", B, `${D}09:00:00Z`))) { why("first"); return false; }
  if (!no(rq(g, "c", B, `${D}09:30:00Z`))) { why("30 min later allowed"); return false; }
  if (!no(rq(g, "c", B, `${D}10:59:00Z`))) { why("1h59 later allowed"); return false; }
  if (!ok(rq(g, "c", B, `${D}11:00:00Z`))) { why("exactly 2h after the first was blocked"); return false; }
  return true;
});
await r.crit("3 the day is the customer's local day, not the UTC day", async (why) => {
  const g = await mod();
  for (const t of ["2026-06-11T00:00:00Z", "2026-06-11T02:30:00Z", "2026-06-11T05:00:00Z"])
    if (!ok(rq(g, "la", LA, t))) { why("setup promo blocked " + t); return false; }
  if (!no(rq(g, "la", LA, "2026-06-11T06:30:00Z"))) { why("23:30 local, same local day, was allowed"); return false; }
  if (!ok(rq(g, "la", LA, "2026-06-11T07:30:00Z"))) { why("00:30 local next day was blocked"); return false; }
  return true;
});
await r.crit("4 a cancelled (failed) send gives back its place in the cap and the gap", async (why) => {
  const g = await mod();
  const a = rq(g, "d", B, `${D}08:00:00Z`), b = rq(g, "d", B, `${D}10:00:00Z`), c = rq(g, "d", B, `${D}12:00:00Z`);
  if (![a, b, c].every(ok)) { why("setup"); return false; }
  if (typeof c.id !== "string" && typeof c.id !== "number") { why("no id returned"); return false; }
  g.cancel(c.id);
  if (!ok(rq(g, "d", B, `${D}12:30:00Z`))) { why("promo after cancel blocked"); return false; }
  if (!no(rq(g, "d", B, `${D}14:30:00Z`))) { why("cap not enforced after cancel and replacement"); return false; }
  return true;
});
await r.crit("5 security alerts are never limited and use no allowance", async (why) => {
  const g = await mod();
  if (!ok(rq(g, "e", B, `${D}08:00:00Z`)) || !ok(rq(g, "e", B, `${D}10:00:00Z`))) { why("setup"); return false; }
  for (const m of ["00", "05", "10"]) if (!ok(rq(g, "e", B, `${D}11:${m}:00Z`, "security"))) { why("security blocked"); return false; }
  if (!ok(rq(g, "e", B, `${D}12:00:00Z`))) { why("third promo blocked after security alerts"); return false; }
  if (!ok(rq(g, "e", B, `${D}12:30:00Z`, "security"))) { why("security blocked at cap"); return false; }
  return true;
});
await r.crit("6 daily cap and gap are reported as different non-empty rules", async (why) => {
  const g = await mod();
  const first = rq(g, "f", B, `${D}08:00:00Z`);
  const gap = rq(g, "f", B, `${D}08:30:00Z`);
  rq(g, "f", B, `${D}10:00:00Z`); rq(g, "f", B, `${D}12:00:00Z`);
  const cap = rq(g, "f", B, `${D}14:00:00Z`);
  const s = (x) => no(x) && typeof x.rule === "string" && x.rule.length > 0;
  if (!s(gap) || !s(cap)) { why("blocked without rule"); return false; }
  if (gap.rule === cap.rule) { why("same rule"); return false; }
  if (!ok(first) || first.rule !== "") { why("allowed rule not empty string"); return false; }
  return true;
});
r.print();
