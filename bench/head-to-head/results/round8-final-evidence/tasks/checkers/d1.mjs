process.env.TZ = "UTC";
import { load, Report } from "./lib.mjs";
const dir = process.argv[2];
const r = new Report();
const user = (tz, o = {}) => ({ id: "u1", timeZone: tz, sms: { optedIn: true, optedOutAt: null, ...o } });
const mkt = { kind: "marketing", text: "Flash sale: 20% off boxes today" };
const txn = { kind: "transactional", text: "Your login code is 481516" };
const call = async (u, m, iso) => (await load(dir)).checkSend({ user: u, message: m, now: new Date(iso) });
const ok = (x) => !!x && x.allowed === true;
const no = (x) => !!x && x.allowed === false;
const NY = "America/New_York";

await r.crit("1 marketing text to a customer whose time zone is unknown is held", async (why) => {
  for (const tz of [null, "Mars/Olympus", "", undefined]) {
    const x = await call(user(tz), mkt, "2026-06-10T17:00:00Z");
    if (!no(x)) { why("tz " + JSON.stringify(tz) + " -> " + JSON.stringify(x)); return false; }
  }
  return true;
});
await r.crit("2 marketing allowed only 08:00 to 20:59 in the customer's own time zone", async (why) => {
  const cases = [
    [NY, "2026-06-10T11:59:00Z", false], [NY, "2026-06-10T12:00:00Z", true],
    [NY, "2026-06-11T00:59:00Z", true], [NY, "2026-06-11T01:00:00Z", false],
    ["Asia/Tokyo", "2026-06-10T12:00:00Z", false], ["Asia/Tokyo", "2026-06-10T01:00:00Z", true],
    ["Asia/Kolkata", "2026-06-10T02:29:00Z", false], ["Asia/Kolkata", "2026-06-10T02:30:00Z", true],
  ];
  for (const [tz, iso, want] of cases) {
    const x = await call(user(tz), mkt, iso);
    if (!(want ? ok(x) : no(x))) { why(`${tz} ${iso} want ${want} got ${JSON.stringify(x)}`); return false; }
  }
  return true;
});
await r.crit("3 daylight saving changes are followed", async (why) => {
  const cases = [
    ["2026-03-08T12:30:00Z", true], ["2026-03-07T12:30:00Z", false],
    ["2026-11-01T12:30:00Z", false], ["2026-11-02T01:30:00Z", true],
  ];
  for (const [iso, want] of cases) {
    const x = await call(user(NY), mkt, iso);
    if (!(want ? ok(x) : no(x))) { why(`${iso} want ${want} got ${JSON.stringify(x)}`); return false; }
  }
  return true;
});
await r.crit("4 no consent or a STOP reply blocks marketing at midday", async (why) => {
  const t = "2026-06-10T16:00:00Z";
  if (!ok(await call(user(NY), mkt, t))) { why("control (opted in) was not allowed"); return false; }
  if (!no(await call(user(NY, { optedIn: false }), mkt, t))) { why("not opted in was allowed"); return false; }
  if (!no(await call(user(NY, { optedOutAt: "2026-06-01T10:00:00Z" }), mkt, t))) { why("opted out was allowed"); return false; }
  return true;
});
await r.crit("5 transactional texts are not held by quiet hours", async (why) => {
  for (const [tz, iso] of [[NY, "2026-06-10T07:00:00Z"], ["Asia/Tokyo", "2026-06-10T18:00:00Z"]]) {
    if (!ok(await call(user(tz), txn, iso))) { why("transactional blocked at night " + tz); return false; }
    if (!no(await call(user(tz), mkt, iso))) { why("marketing control was allowed at night " + tz); return false; }
  }
  return true;
});
await r.crit("6 blocked results name a distinct rule per reason, allowed results an empty rule", async (why) => {
  const q = await call(user(NY), mkt, "2026-06-10T07:00:00Z");
  const q2 = await call(user("Asia/Tokyo"), mkt, "2026-06-10T12:00:00Z");
  const c = await call(user(NY, { optedIn: false }), mkt, "2026-06-10T16:00:00Z");
  const a = await call(user(NY), mkt, "2026-06-10T16:00:00Z");
  const s = (x) => no(x) && typeof x.rule === "string" && x.rule.length > 0;
  if (!s(q) || !s(q2) || !s(c)) { why("missing rule string"); return false; }
  if (q.rule === c.rule) { why("same rule for quiet hours and no consent"); return false; }
  if (q.rule !== q2.rule) { why("different rule strings for the same reason"); return false; }
  if (!ok(a) || a.rule !== "") { why("allowed rule not empty string"); return false; }
  return true;
});
r.print();
