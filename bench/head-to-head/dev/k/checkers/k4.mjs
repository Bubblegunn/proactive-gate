import { load, Report } from "./lib.mjs";
process.env.TZ = "Pacific/Auckland";
const dir = process.argv[2];
const r = new Report();
let seq = 0;
const user = (tz, extra = {}) => ({ id: "u", timeZone: tz, pushEnabled: true, pushToken: "tok", quietHours: { start: "22:00", end: "07:00" }, ...extra });
const msg = (category = "promo", id) => ({ id: id || "m" + ++seq, category, title: "t", body: "b" });
// cases: [user, iso, expectedSend]
async function run(cases, why, category = "promo") {
  const bot = await load(dir);
  let ok = true;
  for (const [u, iso, send] of cases) {
    const x = await bot.decide(u, msg(category), new Date(iso));
    if (!x || !x.push || typeof x.push.send !== "boolean") { why("bad result shape"); return false; }
    if (x.push.send !== send) { why(`${u.timeZone} ${iso}: send ${x.push.send}, want ${send}`); ok = false; }
    if (!x.push.send && (typeof x.push.reason !== "string" || !x.push.reason.trim())) { why(`${iso}: dropped without a reason`); ok = false; }
  }
  return ok;
}
const NY = "America/New_York";
await r.crit("1 quiet hours that cross midnight, and ones that do not", (why) => run([
  [user(NY), "2026-06-11T03:30:00Z", false], [user(NY), "2026-06-11T06:00:00Z", false], [user(NY), "2026-06-10T16:00:00Z", true],
  [user("America/Chicago", { quietHours: { start: "13:00", end: "15:00" } }), "2026-06-10T19:00:00Z", false],
  [user("America/Chicago", { quietHours: { start: "13:00", end: "15:00" } }), "2026-06-10T17:00:00Z", true],
  [user("America/Chicago", { quietHours: { start: "13:00", end: "15:00" } }), "2026-06-10T21:00:00Z", true]], why));
await r.crit("2 edges: start is quiet, end is not; no quiet hours set means none", (why) => run([
  [user(NY), "2026-06-11T02:00:00Z", false], [user(NY), "2026-06-11T01:59:00Z", true],
  [user(NY), "2026-06-10T11:00:00Z", true], [user(NY), "2026-06-10T10:59:00Z", false],
  [user(NY, { quietHours: undefined }), "2026-06-10T07:00:00Z", true]], why));
await r.crit("3 quiet hours follow the person's wall clock through clock changes", (why) => run([
  [user("Europe/Berlin"), "2026-03-29T20:30:00Z", false], [user("Europe/Berlin"), "2026-03-29T19:30:00Z", true],
  [user("Europe/Berlin"), "2026-03-29T05:30:00Z", true], [user("Europe/Berlin"), "2026-03-29T00:30:00Z", false],
  [user(NY), "2026-11-01T11:30:00Z", false], [user(NY), "2026-11-01T03:30:00Z", false], [user(NY), "2026-11-01T12:30:00Z", true]], why));
await r.crit("4 every dropped push still leaves the in-app item, each drop with its own reason", async (why) => {
  const bot = await load(dir); let ok = true; const reasons = [];
  const night = new Date("2026-06-11T06:00:00Z"), day = new Date("2026-06-10T16:00:00Z");
  const cases = [[user(NY), night], [user(NY, { pushEnabled: false }), day], [user(NY, { pushToken: null }), day], [user(NY), day]];
  for (const [u, t] of cases) {
    const x = await bot.decide(u, msg("promo"), t);
    if (!x || x.inApp !== true) { why(`inApp not true (send=${x && x.push && x.push.send})`); ok = false; }
    if (x && x.push && x.push.send === false) reasons.push(String(x.push.reason).trim());
  }
  if (reasons.length !== 3 || new Set(reasons).size !== 3 || reasons.some((s) => !s)) { why("three drops need three different non-empty reasons: " + JSON.stringify(reasons)); ok = false; }
  return ok;
});
await r.crit("5 security alerts go out during quiet hours, promos do not; push off still wins", async (why) => {
  const bot = await load(dir); let ok = true;
  const night = new Date("2026-06-11T06:00:00Z");
  const a = await bot.decide(user(NY), msg("security"), night);
  const b = await bot.decide(user(NY), msg("promo"), night);
  const c = await bot.decide(user(NY, { pushEnabled: false }), msg("security"), night);
  const d = await bot.decide(user(NY, { pushToken: null }), msg("security"), night);
  if (!a.push.send) { why("security alert held at night"); ok = false; }
  if (b.push.send) { why("promo sent at night"); ok = false; }
  if (c.push.send || d.push.send) { why("security alert sent to a person with push off or no token"); ok = false; }
  if (!c.inApp || !d.inApp) { why("inbox item missing for security alert"); ok = false; }
  return ok;
});
await r.crit("6 the same message is never pushed twice, but a held message goes out on retry", async (why) => {
  const bot = await load(dir); let ok = true;
  const u = user(NY);
  const f1 = await bot.decide(u, msg("promo", "A"), new Date("2026-06-10T16:00:00Z"));
  const f2 = await bot.decide(u, msg("promo", "A"), new Date("2026-06-10T16:01:00Z"));
  if (!f1.push.send || f2.push.send) { why(`sent twice or never: first ${f1.push.send}, retry ${f2.push.send}`); ok = false; }
  if (!f2.inApp) { why("inbox item lost on retry"); ok = false; }
  const g1 = await bot.decide(u, msg("promo", "B"), new Date("2026-06-11T03:00:00Z"));
  const g2 = await bot.decide(u, msg("promo", "B"), new Date("2026-06-11T12:00:00Z"));
  const g3 = await bot.decide(u, msg("promo", "B"), new Date("2026-06-11T12:01:00Z"));
  if (g1.push.send) { why("held message sent at night"); ok = false; }
  if (!g2.push.send) { why("held message never went out after quiet hours"); ok = false; }
  if (g3.push.send) { why("pushed twice after the hold"); ok = false; }
  return ok;
});
r.print();
