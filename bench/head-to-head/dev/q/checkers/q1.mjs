import { load, Report, sameInstant } from "./lib.mjs";
const bot = await load(process.argv[2]);
const f = bot.checkSmsWindow;
const C = (tz, extra = {}) => ({ id: "c1", phone: "+14155550100", timeZone: tz, smsConsent: true, ...extra });
const at = (c, iso) => f(c, new Date(iso));
const NY = "America/New_York";
const r = new Report();

await r.crit("1 allowed mid-day in several zones, reason ok, no next time", async (why) => {
  const cases = [[NY, "2026-07-15T14:00:00Z"], ["Asia/Kolkata", "2026-07-15T08:45:00Z"], ["Pacific/Honolulu", "2026-07-15T20:00:00Z"]];
  for (const [tz, iso] of cases) {
    const x = at(C(tz), iso);
    if (!x || x.allowed !== true) { why(`${tz} ${iso} not allowed`); return false; }
    if (x.reason !== "ok") { why(`reason ${x.reason}`); return false; }
    if (x.nextAllowedAt !== null) { why("nextAllowedAt not null when allowed"); return false; }
  }
  return true;
});

await r.crit("2 window edges in New York summer: 07:59 no, 08:00 yes, 20:59 yes, 21:01 no", async (why) => {
  const t = [["2026-07-15T11:59:00Z", false], ["2026-07-15T12:00:00Z", true], ["2026-07-16T00:59:00Z", true], ["2026-07-16T01:01:00Z", false], ["2026-07-15T07:00:00Z", false]];
  for (const [iso, exp] of t) { const x = at(C(NY), iso); if (x.allowed !== exp) { why(`${iso} expected ${exp}`); return false; } }
  return true;
});

await r.crit("3 uses the customer's zone, including a half-hour zone", async (why) => {
  const tokyo = C("Asia/Tokyo"), chi = C("America/Chicago");
  if (at(tokyo, "2026-07-15T14:00:00Z").allowed !== false) { why("Tokyo 23:00 allowed"); return false; }
  if (at(chi, "2026-07-15T14:00:00Z").allowed !== true) { why("Chicago 09:00 blocked"); return false; }
  if (at(tokyo, "2026-07-15T03:00:00Z").allowed !== true) { why("Tokyo 12:00 blocked"); return false; }
  if (at(chi, "2026-07-15T03:00:00Z").allowed !== false) { why("Chicago 22:00 allowed"); return false; }
  const k = C("Asia/Kolkata");
  if (at(k, "2026-07-15T02:30:00Z").allowed !== true) { why("Kolkata 08:00 blocked"); return false; }
  if (at(k, "2026-07-15T02:29:00Z").allowed !== false) { why("Kolkata 07:59 allowed"); return false; }
  return true;
});

await r.crit("4 daylight saving: both transitions in New York", async (why) => {
  const t = [["2026-03-08T12:30:00Z", true], ["2026-03-08T11:30:00Z", false], ["2026-11-01T12:30:00Z", false], ["2026-11-01T13:30:00Z", true], ["2026-11-02T01:30:00Z", true], ["2026-11-02T02:30:00Z", false]];
  for (const [iso, exp] of t) { const x = at(C(NY), iso); if (x.allowed !== exp) { why(`${iso} expected ${exp}`); return false; } }
  return true;
});

await r.crit("5 nextAllowedAt is the next 08:00 local, across night, evening and DST", async (why) => {
  const t = [
    ["2026-07-15T07:00:00Z", "2026-07-15T12:00:00Z"],
    ["2026-07-16T02:00:00Z", "2026-07-16T12:00:00Z"],
    ["2026-07-16T01:30:00Z", "2026-07-16T12:00:00Z"],
    ["2026-03-08T03:00:00Z", "2026-03-08T12:00:00Z"],
    ["2026-11-01T02:00:00Z", "2026-11-01T13:00:00Z"],
  ];
  for (const [now, next] of t) {
    const x = at(C(NY), now);
    if (x.allowed !== false) { why(`${now} allowed`); return false; }
    if (!sameInstant(x.nextAllowedAt, next)) { why(`${now} next=${x.nextAllowedAt} want ${next}`); return false; }
  }
  const s = at(C("Australia/Sydney"), "2026-07-15T12:00:00Z");
  if (s.allowed !== false || !sameInstant(s.nextAllowedAt, "2026-07-15T22:00:00Z")) { why("Sydney next wrong " + JSON.stringify(s)); return false; }
  return true;
});

await r.crit("6 no consent, missing or garbage zone: blocked, no throw, distinct reasons", async (why) => {
  const noon = "2026-07-15T16:00:00Z";
  const nc = at(C(NY, { smsConsent: false }), noon);
  if (nc.allowed !== false || nc.nextAllowedAt !== null) { why("no-consent not blocked permanently " + JSON.stringify(nc)); return false; }
  const bad = [at(C(undefined), noon), at(C("Mars/Olympus"), noon), at(C(""), noon), at(C(null), noon)];
  for (const b of bad) if (b.allowed !== false || b.nextAllowedAt !== null) { why("bad tz not blocked: " + JSON.stringify(b)); return false; }
  const night = at(C(NY), "2026-07-15T07:00:00Z");
  const rs = [nc.reason, bad[0].reason, night.reason];
  if (rs.some((x) => typeof x !== "string" || !x || x === "ok")) { why("bad reason " + rs); return false; }
  if (new Set(rs).size !== 3) { why("reasons not distinct " + rs); return false; }
  return true;
});
r.print();
