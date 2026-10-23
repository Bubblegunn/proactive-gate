import { load, D, sameInstant, Report } from "./lib.mjs";
process.env.TZ = "Pacific/Auckland"; // server zone must not matter
const dir = process.argv[2];
const r = new Report();
const U = (tz) => ({ id: "u1", phone: "+15555550100", timeZone: tz });
// cases: [tz, iso, expectedAllowed, expectedNextIso|null]
async function run(cases, why) {
  const bot = await load(dir);
  let ok = true;
  for (const [tz, iso, al, next] of cases) {
    const x = await bot.checkSms(U(tz), D(iso));
    if (!x || typeof x.allowed !== "boolean") { why(`${tz} ${iso}: no boolean allowed`); ok = false; continue; }
    if (x.allowed !== al) { why(`${tz} ${iso}: allowed ${x.allowed}, want ${al}`); ok = false; continue; }
    if (!al) {
      if (typeof x.reason !== "string" || !x.reason.trim()) { why(`${tz} ${iso}: empty reason`); ok = false; }
      if (next && !sameInstant(x.nextAllowedAt, next)) { why(`${tz} ${iso}: next ${x.nextAllowedAt}, want ${next}`); ok = false; }
    } else if (x.nextAllowedAt !== null && x.nextAllowedAt !== undefined) { why(`${tz} ${iso}: next should be null`); ok = false; }
  }
  return ok;
}
const CH = "America/Chicago", NY = "America/New_York";
await r.crit("1 window edges at the recipient (07:59, 08:00, 20:59, 21:01)", (why) => run([
  [CH, "2026-06-10T12:59:00Z", false, null], [CH, "2026-06-10T13:00:00Z", true, null],
  [CH, "2026-06-11T01:59:00Z", true, null], [CH, "2026-06-11T02:01:00Z", false, null]], why));
await r.crit("2 the recipient's zone is used, not the server's", (why) => run([
  ["Asia/Tokyo", "2026-06-10T13:00:00Z", false, null], [CH, "2026-06-10T13:00:00Z", true, null],
  ["America/Los_Angeles", "2026-06-10T13:00:00Z", false, null], ["Pacific/Honolulu", "2026-06-10T13:00:00Z", false, null],
  [NY, "2026-06-10T13:00:00Z", true, null], ["Europe/London", "2026-06-10T13:00:00Z", true, null]], why));
await r.crit("3 refusal carries the next 08:00 local (same day, next day, month and year rollover)", (why) => run([
  [CH, "2026-06-10T10:30:00Z", false, "2026-06-10T13:00:00Z"], [CH, "2026-06-11T03:00:00Z", false, "2026-06-11T13:00:00Z"],
  ["Asia/Tokyo", "2026-06-10T13:00:00Z", false, "2026-06-10T23:00:00Z"], [CH, "2026-06-11T06:00:00Z", false, "2026-06-11T13:00:00Z"],
  [CH, "2026-07-01T03:00:00Z", false, "2026-07-01T13:00:00Z"], ["America/Los_Angeles", "2027-01-01T06:00:00Z", false, "2027-01-01T16:00:00Z"]], why));
await r.crit("4 spring-forward day (New York 8 March 2026)", (why) => run([
  [NY, "2026-03-08T03:00:00Z", false, "2026-03-08T12:00:00Z"], [NY, "2026-03-08T05:30:00Z", false, "2026-03-08T12:00:00Z"],
  [NY, "2026-03-08T07:30:00Z", false, "2026-03-08T12:00:00Z"], [NY, "2026-03-08T11:30:00Z", false, "2026-03-08T12:00:00Z"],
  [NY, "2026-03-08T12:00:00Z", true, null], [NY, "2026-03-08T12:30:00Z", true, null]], why));
await r.crit("5 fall-back day (New York 1 November 2026)", (why) => run([
  [NY, "2026-11-01T02:00:00Z", false, "2026-11-01T13:00:00Z"], [NY, "2026-11-01T05:30:00Z", false, "2026-11-01T13:00:00Z"],
  [NY, "2026-11-01T06:30:00Z", false, "2026-11-01T13:00:00Z"], [NY, "2026-11-01T12:30:00Z", false, "2026-11-01T13:00:00Z"],
  [NY, "2026-11-01T13:00:00Z", true, null]], why));
await r.crit("6 zones with a half-hour or 45-minute offset (India, Nepal)", (why) => run([
  ["Asia/Kolkata", "2026-06-10T15:15:00Z", true, null], ["Asia/Kolkata", "2026-06-10T15:45:00Z", false, "2026-06-11T02:30:00Z"],
  ["Asia/Kathmandu", "2026-06-10T02:10:00Z", false, "2026-06-10T02:15:00Z"], ["Asia/Kathmandu", "2026-06-10T02:20:00Z", true, null],
  ["Asia/Kathmandu", "2026-06-10T15:20:00Z", false, "2026-06-11T02:15:00Z"]], why));
r.print();
