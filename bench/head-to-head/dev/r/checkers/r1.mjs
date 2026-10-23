import { load, Report } from "./lib.mjs";
process.env.TZ = "Pacific/Auckland"; // the machine's own zone must not matter
const bot = await load(process.argv[2]);
const U = (o = {}) => ({ id: "u1", phone: "+14155550100", timeZone: "America/New_York", smsConsentAt: "2025-01-01T00:00:00Z", smsOptOutAt: null, ...o });
const chk = (user, iso) => bot.checkSms({ user, now: new Date(iso) });
const al = (r) => !!r && r.allowed === true;
const bl = (r) => !!r && r.allowed === false;
const r = new Report();
await r.crit("1 quiet hours 8:00 to 21:00 local", async (why) => {
  const a = [chk(U(), "2026-01-15T12:59:59Z"), chk(U(), "2026-01-15T13:00:00Z"), chk(U(), "2026-01-16T01:59:59Z"), chk(U(), "2026-01-16T02:30:00Z"), chk(U(), "2026-01-15T07:00:00Z")];
  const ok = bl(a[0]) && al(a[1]) && al(a[2]) && bl(a[3]) && bl(a[4]);
  if (!ok) why("07:59:59 blocked, 08:00 ok, 20:59:59 ok, 21:30 blocked, 02:00 blocked: " + a.map((x) => x && x.allowed).join(","));
  return ok;
});
await r.crit("2 uses the recipient's own time zone", async (why) => {
  const t1 = "2026-06-10T03:00:00Z", t2 = "2026-06-10T22:00:00Z";
  const a = [chk(U(), t1), chk(U({ timeZone: "Asia/Tokyo" }), t1), chk(U({ timeZone: "America/Los_Angeles" }), t1), chk(U({ timeZone: "Australia/Sydney" }), t1),
    chk(U(), t2), chk(U({ timeZone: "Asia/Tokyo" }), t2), chk(U({ timeZone: "Australia/Sydney" }), t2)];
  const ok = bl(a[0]) && al(a[1]) && al(a[2]) && al(a[3]) && al(a[4]) && bl(a[5]) && al(a[6]);
  if (!ok) why(a.map((x) => x && x.allowed).join(","));
  return ok;
});
await r.crit("3 daylight saving transitions", async (why) => {
  const a = [chk(U(), "2026-03-08T12:30:00Z"), chk(U(), "2026-03-08T11:30:00Z"),
    chk(U({ timeZone: "America/Los_Angeles" }), "2026-11-01T15:30:00Z"), chk(U({ timeZone: "America/Los_Angeles" }), "2026-11-01T16:30:00Z")];
  const ok = al(a[0]) && bl(a[1]) && bl(a[2]) && al(a[3]);
  if (!ok) why(a.map((x) => x && x.allowed).join(","));
  return ok;
});
await r.crit("4 consent and opt-out: the latest event wins", async (why) => {
  const t = "2026-01-15T17:00:00Z";
  const a = [chk(U({ smsConsentAt: null }), t), chk(U(), t),
    chk(U({ smsConsentAt: "2025-01-01T00:00:00Z", smsOptOutAt: "2025-06-01T00:00:00Z" }), t),
    chk(U({ smsConsentAt: "2025-09-01T00:00:00Z", smsOptOutAt: "2025-06-01T00:00:00Z" }), t)];
  const ok = bl(a[0]) && al(a[1]) && bl(a[2]) && al(a[3]);
  if (!ok) why(a.map((x) => x && x.allowed).join(","));
  return ok;
});
await r.crit("5 unknown time zone is held back without crashing", async (why) => {
  for (const tz of [null, "", "Mars/Olympus", 42]) {
    let res;
    try { res = chk(U({ timeZone: tz }), "2026-01-15T17:00:00Z"); } catch (e) { why("threw for " + JSON.stringify(tz)); return false; }
    if (!bl(res)) { why("not blocked for " + JSON.stringify(tz)); return false; }
  }
  return true;
});
await r.crit("6 each cause has its own rule name", async (why) => {
  const t = "2026-01-15T17:00:00Z";
  const res = [chk(U({ smsConsentAt: null }), t), chk(U({ smsOptOutAt: "2025-06-01T00:00:00Z" }), t), chk(U(), "2026-01-15T07:00:00Z"), chk(U({ timeZone: "Mars/Olympus" }), t), chk(U(), t)];
  const names = res.map((x) => x && x.rule);
  const ok = names.every((n) => typeof n === "string" && n.trim()) && new Set(names).size === 5;
  if (!ok) why(JSON.stringify(names));
  return ok;
});
r.print();
