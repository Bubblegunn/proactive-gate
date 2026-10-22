import { load, Report } from "./lib.mjs";
const dir = process.argv[2];
const r = new Report();
const NY = "America/New_York"; // June: UTC-4
const mk = (userId, category, timezone = NY, quietStart = "22:00", quietEnd = "07:00") => ({ userId, category, timezone, quietStart, quietEnd });
// June 1 2026 local NY hour h -> Date
const ny = (day, h, m = 0) => new Date(Date.UTC(2026, 5, day, h + 4, m));
const mkt = (u, tz, qs, qe) => mk(u, "marketing", tz, qs, qe);

await r.crit("1 quiet window that wraps past midnight holds marketing push", async (why) => {
  const bot = await load(dir);
  const a = bot.decide(mkt("a"), ny(2, 23, 30)); // 23:30 local
  const b = bot.decide(mkt("b"), ny(2, 3, 0)); // 03:00 local
  const c = bot.decide(mkt("c"), ny(2, 7, 30)); // 07:30 local, outside window
  const d = bot.decide(mkt("d", NY, "13:00", "15:00"), ny(2, 14, 0)); // same-day window
  const e = bot.decide(mkt("e"), ny(2, 12, 0));
  why(JSON.stringify([a, b, c, d, e]));
  return a.send === false && b.send === false && c.send === true && d.send === false && e.send === true;
});
await r.crit("2 fourth marketing push on the same day is held", async (why) => {
  const bot = await load(dir);
  const v = [10, 11, 12, 13].map((h) => bot.decide(mkt("u"), ny(2, h)));
  why(JSON.stringify(v));
  return v[0].send && v[1].send && v[2].send && v[3].send === false && typeof v[3].rule === "string" && v[3].rule.length > 0;
});
await r.crit("3 pushes held by quiet hours do not use up the daily allowance", async (why) => {
  const bot = await load(dir);
  for (const m of [0, 15, 30, 45, 59]) { const x = bot.decide(mkt("u"), ny(2, 3, m)); if (x.send !== false) { why("night push sent"); return false; } }
  const v = [10, 11, 12].map((h) => bot.decide(mkt("u"), ny(2, h)).send);
  const w = bot.decide(mkt("u"), ny(2, 13)).send;
  why(JSON.stringify([v, w]));
  return v.every(Boolean) && w === false;
});
await r.crit("4 transactional pushes are never held by the cap and do not count towards it", async (why) => {
  const bot = await load(dir);
  const t1 = [8, 8, 9, 9, 9].map((h, i) => bot.decide(mk("u", "transactional"), ny(2, h, i)).send);
  const m = [10, 11, 12, 13].map((h) => bot.decide(mkt("u"), ny(2, h)).send);
  const t2 = bot.decide(mk("u", "transactional"), ny(2, 14)).send;
  why(JSON.stringify([t1, m, t2]));
  return t1.every(Boolean) && m[0] && m[1] && m[2] && m[3] === false && t2 === true;
});
await r.crit("5 the daily allowance restarts at the customer's local midnight", async (why) => {
  const bot = await load(dir);
  // 20:00, 20:30, 21:00 local on June 1 are already June 2 in UTC
  const v = [[20, 0], [20, 30], [21, 0]].map(([h, m]) => bot.decide(mkt("u"), ny(1, h, m)).send);
  const held = bot.decide(mkt("u"), ny(1, 21, 30)).send;
  const next = bot.decide(mkt("u"), ny(2, 8, 0)).send;
  // a customer in Tokyo (UTC+9): same local day spans two UTC days
  const tk = (day, h) => new Date(Date.UTC(2026, 5, day, h - 9));
  const tv = [8, 9, 10].map((h) => bot.decide(mkt("t", "Asia/Tokyo"), tk(2, h)).send);
  const th = bot.decide(mkt("t", "Asia/Tokyo"), tk(2, 11)).send;
  why(JSON.stringify([v, held, next, tv, th]));
  return v.every(Boolean) && held === false && next === true && tv.every(Boolean) && th === false;
});
await r.crit("6 each held push names a rule, and cap and quiet hours are told apart", async (why) => {
  const bot = await load(dir);
  const ok = bot.decide(mkt("u"), ny(2, 10));
  [11, 12].forEach((h) => bot.decide(mkt("u"), ny(2, h)));
  const cap = bot.decide(mkt("u"), ny(2, 13));
  const quiet = bot.decide(mkt("q"), ny(2, 23, 30));
  why(JSON.stringify([ok, cap, quiet]));
  return ok.send === true && ok.rule === null && typeof cap.rule === "string" && cap.rule && typeof quiet.rule === "string" && quiet.rule && cap.rule !== quiet.rule;
});
r.print();
