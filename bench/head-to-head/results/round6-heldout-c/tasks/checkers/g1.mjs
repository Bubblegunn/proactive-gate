import { load, Report } from "./lib.mjs";
const bot = await load(process.argv[2]);
const r = new Report();
const chk = (tz, iso) => bot.checkSms({ id: "u", phone: "+13125550142", timezone: tz }, new Date(iso));
const toMs = (d) => (d instanceof Date ? d.getTime() : typeof d === "string" ? Date.parse(d) : NaN);
await r.crit("1 text at night local time is held back", async (why) => {
  const a = chk("America/Chicago", "2026-06-02T02:30:00Z"); // 21:30 CDT
  const b = chk("Asia/Kolkata", "2026-06-01T16:00:00Z"); // 21:30 IST
  const c = chk("America/Los_Angeles", "2026-01-15T12:00:00Z"); // 04:00 PST
  why(JSON.stringify([a.allowed, b.allowed, c.allowed]));
  if (a.allowed !== false || b.allowed !== false || c.allowed !== false) return false;
  return typeof a.reason === "string" && a.reason.length > 3;
});
await r.crit("2 text at midday local time is allowed", async (why) => {
  const a = chk("America/Chicago", "2026-06-01T17:00:00Z"); // 12:00 CDT
  const b = chk("Asia/Kolkata", "2026-06-01T05:00:00Z"); // 10:30 IST
  const c = chk("Pacific/Honolulu", "2026-06-01T22:00:00Z"); // 12:00 HST
  why(JSON.stringify([a.allowed, b.allowed, c.allowed]));
  return a.allowed === true && b.allowed === true && c.allowed === true && a.nextAllowedAt == null;
});
await r.crit("3 window edges 07:59 held, 08:01 ok, 20:59 ok, 21:01 held", async (why) => {
  const z = "America/Los_Angeles"; // PDT = UTC-7 in June
  const v = [chk(z, "2026-06-01T14:59:00Z"), chk(z, "2026-06-01T15:01:00Z"), chk(z, "2026-06-02T03:59:00Z"), chk(z, "2026-06-02T04:01:00Z")].map((x) => x.allowed);
  why(JSON.stringify(v));
  return v[0] === false && v[1] === true && v[2] === true && v[3] === false;
});
await r.crit("4 daylight saving change days use the real offset", async (why) => {
  // 2026-03-08 US clocks go forward: 12:30Z = 08:30 EDT (ok); 11:30Z = 07:30 EDT (held)
  const a = chk("America/New_York", "2026-03-08T12:30:00Z");
  const b = chk("America/New_York", "2026-03-08T11:30:00Z");
  // 2026-11-01 clocks go back: 12:30Z = 07:30 EST (held), 13:30Z = 08:30 EST (ok)
  const c = chk("America/New_York", "2026-11-01T12:30:00Z");
  const d = chk("America/New_York", "2026-11-01T13:30:00Z");
  why(JSON.stringify([a.allowed, b.allowed, c.allowed, d.allowed]));
  return a.allowed === true && b.allowed === false && c.allowed === false && d.allowed === true;
});
await r.crit("5 nextAllowedAt is the next 08:00 local, not earlier", async (why) => {
  const a = chk("America/New_York", "2026-01-15T03:00:00Z"); // 22:00 EST -> 13:00Z
  const b = chk("America/Los_Angeles", "2026-06-01T14:00:00Z"); // 07:00 PDT -> 15:00Z same day
  why(JSON.stringify([a.nextAllowedAt, b.nextAllowedAt]));
  return a.allowed === false && b.allowed === false && toMs(a.nextAllowedAt) === Date.parse("2026-01-15T13:00:00Z") && toMs(b.nextAllowedAt) === Date.parse("2026-06-01T15:00:00Z");
});
await r.crit("6 unknown or missing time zone is not texted", async (why) => {
  const t = "2026-06-01T17:00:00Z";
  const v = [chk(null, t), chk("Mars/Olympus", t), chk(undefined, t), chk("", t)];
  why(JSON.stringify(v.map((x) => x.allowed)));
  return v.every((x) => x.allowed === false && typeof x.reason === "string" && x.reason.length > 3);
});
r.print();
