import { load, D, sameInstant, Report } from "./lib.mjs";
const dir = process.argv[2];
const r = new Report();
const m = await load(dir);
const base = { to: "+15551230000", timeZone: "America/Chicago", kind: "marketing", marketingConsent: true };
const chk = (o, iso) => m.checkSms({ ...base, ...o }, D(iso));
// Chicago in January is UTC-6.
await r.crit("1 no marketing text before 08:00 local", async (why) => {
  const a = chk({}, "2026-01-14T13:59:00Z"); // 07:59 local
  const b = chk({}, "2026-01-14T14:01:00Z"); // 08:01 local
  const c = chk({}, "2026-01-14T07:00:00Z"); // 01:00 local
  if (a.allowed !== false) why("07:59 local allowed");
  if (c.allowed !== false) why("01:00 local allowed");
  if (b.allowed !== true) why("08:01 local blocked");
  return a.allowed === false && c.allowed === false && b.allowed === true;
});
await r.crit("2 no marketing text after 21:00 local", async (why) => {
  const a = chk({}, "2026-01-15T02:59:00Z"); // 20:59 local
  const b = chk({}, "2026-01-15T03:01:00Z"); // 21:01 local
  const c = chk({}, "2026-01-15T05:30:00Z"); // 23:30 local
  if (a.allowed !== true) why("20:59 local blocked");
  if (b.allowed !== false) why("21:01 local allowed");
  if (c.allowed !== false) why("23:30 local allowed");
  return a.allowed === true && b.allowed === false && c.allowed === false;
});
await r.crit("3 recipient zone and daylight saving time respected", async (why) => {
  const ny = { timeZone: "America/New_York" };
  const hon = { timeZone: "Pacific/Honolulu" };
  const res = [
    [chk(ny, "2026-07-01T12:30:00Z"), true, "08:30 EDT"],
    [chk(ny, "2026-07-01T11:30:00Z"), false, "07:30 EDT"],
    [chk(ny, "2026-01-15T12:30:00Z"), false, "07:30 EST"],
    [chk(ny, "2026-01-15T13:30:00Z"), true, "08:30 EST"],
    [chk(ny, "2026-07-02T01:30:00Z"), false, "21:30 EDT"],
    [chk(hon, "2026-01-15T17:30:00Z"), false, "07:30 HST"],
    [chk(hon, "2026-01-15T18:30:00Z"), true, "08:30 HST"],
  ];
  let ok = true;
  for (const [x, want, label] of res) if (x.allowed !== want) { ok = false; why(label + " expected " + want); }
  return ok;
});
await r.crit("4 transactional text is not held back at night", async (why) => {
  const a = chk({ kind: "transactional" }, "2026-01-15T09:00:00Z"); // 03:00 local
  const b = chk({ kind: "transactional" }, "2026-01-15T03:30:00Z"); // 21:30 local
  const c = chk({ kind: "transactional", marketingConsent: false }, "2026-01-15T09:00:00Z");
  if (!a.allowed) why("03:00 code blocked");
  if (!b.allowed) why("21:30 update blocked");
  if (!c.allowed) why("transactional blocked without marketing consent");
  return a.allowed && b.allowed && c.allowed;
});
await r.crit("5 marketing without consent is blocked even at midday", async (why) => {
  const a = chk({ marketingConsent: false }, "2026-01-14T18:00:00Z");
  const b = chk({ marketingConsent: true }, "2026-01-14T18:00:00Z");
  if (a.allowed !== false) why("sent without consent");
  if (b.allowed !== true) why("consented midday blocked");
  return a.allowed === false && b.allowed === true;
});
await r.crit("6 blockedBy named and nextAllowedAt is next 08:00 local", async (why) => {
  const late = chk({}, "2026-01-15T03:30:00Z"); // 21:30 local Jan 14
  const early = chk({}, "2026-01-14T11:00:00Z"); // 05:00 local Jan 14
  const ny = chk({ timeZone: "America/New_York" }, "2026-03-08T02:30:00Z"); // 21:30 EST Mar 7, DST starts at 02:00 Mar 8
  const noc = chk({ marketingConsent: false }, "2026-01-14T18:00:00Z");
  const ok1 = typeof late.blockedBy === "string" && late.blockedBy.length > 0 && typeof noc.blockedBy === "string" && noc.blockedBy.length > 0;
  if (!ok1) why("blockedBy missing");
  const ok2 = sameInstant(late.nextAllowedAt, "2026-01-15T14:00:00Z");
  if (!ok2) why("late: " + late.nextAllowedAt);
  const ok3 = sameInstant(early.nextAllowedAt, "2026-01-14T14:00:00Z");
  if (!ok3) why("early: " + early.nextAllowedAt);
  const ok4 = sameInstant(ny.nextAllowedAt, "2026-03-08T12:00:00Z");
  if (!ok4) why("dst: " + ny.nextAllowedAt);
  const ok5 = chk({}, "2026-01-14T18:00:00Z").blockedBy == null && chk({}, "2026-01-14T18:00:00Z").nextAllowedAt == null;
  if (!ok5) why("allowed result carries blockedBy/nextAllowedAt");
  return ok1 && ok2 && ok3 && ok4 && ok5;
});
r.print();
