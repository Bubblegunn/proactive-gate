import { load, D, Report } from "./lib.mjs";
const dir = process.argv[2];
const r = new Report();
const m = await load(dir);
let n = 0;
const msg = (o = {}) => ({
  userId: "u1", category: "reminder", dedupeKey: "k" + ++n, timeZone: "UTC",
  optIn: { marketing: true, reminder: true, security: true },
  quietHours: { start: "22:00", end: "07:00" }, ...o,
});
const at = (hhmm, day = "2026-03-10") => D(`${day}T${hhmm}:00Z`);
await r.crit("1 category opt-in is enforced per category", async (why) => {
  const g = m.createGate();
  const noMkt = { marketing: false, reminder: true, security: true };
  const a = g.check(msg({ category: "marketing", optIn: noMkt }), at("12:00"));
  const b = g.check(msg({ category: "reminder", optIn: noMkt }), at("12:00"));
  const c = g.check(msg({ category: "marketing" }), at("12:00"));
  const d = g.check(msg({ category: "reminder", optIn: { marketing: true, reminder: false, security: true } }), at("12:00"));
  if (a.allowed !== false) why("marketing sent without opt-in");
  if (b.allowed !== true) why("reminder blocked although opted in");
  if (c.allowed !== true) why("opted-in marketing blocked");
  if (d.allowed !== false) why("reminder sent without opt-in");
  return a.allowed === false && b.allowed === true && c.allowed === true && d.allowed === false;
});
await r.crit("2 overnight quiet window: start inclusive, end exclusive, wraps midnight", async (why) => {
  const g = m.createGate();
  const want = [["21:59", true], ["22:00", false], ["23:30", false], ["03:00", false], ["06:59", false], ["07:00", true], ["12:00", true]];
  let ok = true;
  for (const [t, allowed] of want) {
    const x = g.check(msg(), at(t));
    if (x.allowed !== allowed) { ok = false; why(t + " expected " + allowed); }
  }
  const day = { start: "13:00", end: "15:00" };
  for (const [t, allowed] of [["12:00", true], ["14:00", false], ["15:00", true]]) {
    const x = g.check(msg({ quietHours: day }), at(t));
    if (x.allowed !== allowed) { ok = false; why("custom window " + t + " expected " + allowed); }
  }
  return ok;
});
await r.crit("3 quiet hours use the user's own zone, including daylight saving", async (why) => {
  const g = m.createGate();
  const inst = D("2026-06-15T14:00:00Z");
  const tokyo = g.check(msg({ timeZone: "Asia/Tokyo" }), inst); // 23:00
  const ny = g.check(msg({ timeZone: "America/New_York" }), inst); // 10:00
  const nyDst = g.check(msg({ timeZone: "America/New_York" }), D("2026-06-15T02:30:00Z")); // 22:30 EDT
  const nyWin = g.check(msg({ timeZone: "America/New_York" }), D("2026-01-15T03:30:00Z")); // 22:30 EST
  const nyWinOk = g.check(msg({ timeZone: "America/New_York" }), D("2026-01-15T12:30:00Z")); // 07:30 EST
  if (tokyo.allowed !== false) why("Tokyo 23:00 allowed");
  if (ny.allowed !== true) why("New York 10:00 blocked");
  if (nyDst.allowed !== false) why("New York 22:30 EDT allowed");
  if (nyWin.allowed !== false) why("New York 22:30 EST allowed");
  if (nyWinOk.allowed !== true) why("New York 07:30 EST blocked");
  return tokyo.allowed === false && ny.allowed === true && nyDst.allowed === false && nyWin.allowed === false && nyWinOk.allowed === true;
});
await r.crit("4 security alerts go out even in quiet hours or without opt-in", async (why) => {
  const g = m.createGate();
  const none = { marketing: false, reminder: false, security: false };
  const a = g.check(msg({ category: "security", optIn: none }), at("03:00"));
  const b = g.check(msg({ category: "security" }), at("23:00"));
  if (a.allowed !== true) why("security blocked at 03:00 with all opt-ins off");
  if (b.allowed !== true) why("security blocked at 23:00");
  return a.allowed === true && b.allowed === true;
});
await r.crit("5 same notification is not repeated within 24 hours; blocked ones are not recorded", async (why) => {
  const g = m.createGate();
  const k = { dedupeKey: "same" };
  const t0 = D("2026-03-10T12:00:00Z");
  const ok0 = g.check(msg(k), t0);
  const ok1 = g.check(msg(k), new Date(t0.getTime() + 3600e3));
  const ok2 = g.check(msg(k), new Date(t0.getTime() + 23 * 3600e3));
  const ok3 = g.check(msg(k), new Date(t0.getTime() + 24 * 3600e3 + 60e3));
  const oth = g.check(msg({ ...k, userId: "u2" }), new Date(t0.getTime() + 3600e3));
  // blocked by quiet hours at 23:30, then retried at 07:30: allowed, it was never sent
  const ok4 = g.check(msg({ dedupeKey: "late" }), D("2026-03-10T23:30:00Z"));
  const ok5 = g.check(msg({ dedupeKey: "late" }), D("2026-03-11T07:30:00Z"));
  const res = [ok0.allowed, ok1.allowed, ok2.allowed, ok3.allowed, oth.allowed, ok4.allowed, ok5.allowed];
  const want = [true, false, false, true, true, false, true];
  const ok = res.every((v, i) => v === want[i]);
  if (!ok) why(JSON.stringify(res) + " expected " + JSON.stringify(want));
  return ok;
});
await r.crit("6 blockedBy tells the three stopping rules apart and is empty when allowed", async (why) => {
  const g = m.createGate();
  const optout = g.check(msg({ category: "marketing", optIn: { marketing: false, reminder: true, security: true } }), at("12:00"));
  const quiet = g.check(msg(), at("23:30"));
  g.check(msg({ dedupeKey: "dup" }), at("12:00"));
  const dup = g.check(msg({ dedupeKey: "dup" }), at("13:00"));
  const okx = g.check(msg(), at("14:00"));
  const names = [optout, quiet, dup].map((x) => x.blockedBy);
  const named = names.every((s) => typeof s === "string" && s.length > 0);
  const distinct = new Set(names).size === 3;
  const clean = okx.allowed === true && okx.blockedBy == null;
  if (!named) why("missing names " + JSON.stringify(names));
  else if (!distinct) why("not distinct " + JSON.stringify(names));
  if (!clean) why("allowed result has blockedBy");
  return named && distinct && clean;
});
r.print();
