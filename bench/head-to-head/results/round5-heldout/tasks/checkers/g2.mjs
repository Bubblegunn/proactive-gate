import { load, D, Report } from "./lib.mjs";
const bot = await load(process.argv[2]);
const r = new Report();
const U = (o = {}) => ({ id: "u1", timeZone: "America/Chicago", quietStart: "22:00", quietEnd: "07:00", dailyCap: 3, ...o });
const ok = (x) => x && x.allowed === true && x.reason === null;
const no = (x) => x && x.allowed === false && typeof x.reason === "string" && x.reason.length > 0;
// 2026-01-15 Chicago = UTC-6
const t = (h, m = 0) => D(`2026-01-15T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);

await r.crit("1 the daily cap stops the push after dailyCap sends", async (why) => {
  const g = bot.createPushGate();
  const res = [t(16), t(17), t(18), t(19), t(20)].map((n) => g.attempt(U(), n));
  if (!(ok(res[0]) && ok(res[1]) && ok(res[2]) && no(res[3]) && no(res[4]))) { why(JSON.stringify(res)); return false; }
  const g2 = bot.createPushGate();
  const a = [t(16), t(17)].map((n) => g2.attempt(U({ dailyCap: 1 }), n));
  return ok(a[0]) && no(a[1]);
});
await r.crit("2 the cap resets at the user's local midnight, not at UTC midnight", async (why) => {
  const g = bot.createPushGate();
  const u = U({ id: "tk", timeZone: "Asia/Tokyo", quietStart: "02:00", quietEnd: "05:00" });
  // Tokyo = UTC+9. 2026-01-15T11:00Z = 20:00 JST
  const first = [D("2026-01-15T11:00:00Z"), D("2026-01-15T11:10:00Z"), D("2026-01-15T11:20:00Z")].map((n) => g.attempt(u, n));
  const late = g.attempt(u, D("2026-01-15T14:00:00Z")); // 23:00 JST, same local day
  const next = g.attempt(u, D("2026-01-15T15:30:00Z")); // 00:30 JST next day, same UTC date
  const later = g.attempt(u, D("2026-01-16T10:00:00Z")); // 19:00 JST next day
  if (!first.every(ok) || !no(late) || !ok(next) || !ok(later)) { why(JSON.stringify([first, late, next, later])); return false; }
  return true;
});
await r.crit("3 the local day follows daylight saving", async (why) => {
  const g = bot.createPushGate();
  const u = U({ id: "ny", timeZone: "America/New_York", quietStart: "02:00", quietEnd: "05:00" });
  // 2026-03-08 US clocks move forward; 00:00Z on 03-09 = 20:00 EDT on 03-08. Local midnight = 04:00Z.
  const first = ["2026-03-09T00:00:00Z", "2026-03-09T00:10:00Z", "2026-03-09T00:20:00Z"].map((n) => g.attempt(u, D(n)));
  const same = g.attempt(u, D("2026-03-09T03:30:00Z")); // 23:30 EDT, same local day
  const next = g.attempt(u, D("2026-03-09T04:30:00Z")); // 00:30 EDT, new local day
  if (!first.every(ok) || !no(same) || !ok(next)) { why(JSON.stringify([first, same, next])); return false; }
  return true;
});
await r.crit("4 quiet hours that run past midnight block, edges are 22:00 in and 07:00 out", async (why) => {
  const g = bot.createPushGate();
  const u = U({ dailyCap: 100 });
  // Chicago UTC-6: 21:59 local = 03:59Z next day
  const cases = [["2026-01-16T03:59:00Z", true], ["2026-01-16T04:00:00Z", false], ["2026-01-16T09:00:00Z", false], ["2026-01-16T12:59:00Z", false], ["2026-01-16T13:00:00Z", true], ["2026-01-15T20:00:00Z", true]];
  for (const [iso, allowed] of cases) {
    const x = g.attempt(U({ dailyCap: 100 }), D(iso));
    if (allowed ? !ok(x) : !no(x)) { why(iso + " -> " + JSON.stringify(x)); return false; }
  }
  const g2 = bot.createPushGate();
  const day = U({ quietStart: "13:00", quietEnd: "15:00", dailyCap: 100 }); // same-day window
  const a = g2.attempt(day, D("2026-01-15T20:00:00Z")); // 14:00 local
  const b = g2.attempt(day, D("2026-01-15T22:00:00Z")); // 16:00 local
  if (!no(a) || !ok(b)) { why("same-day window " + JSON.stringify([a, b])); return false; }
  return true;
});
await r.crit("5 a blocked attempt does not use up the daily cap, and cap and quiet codes differ", async (why) => {
  const g = bot.createPushGate();
  const night = [];
  for (let i = 0; i < 6; i++) night.push(g.attempt(U(), D(`2026-01-15T10:${10 + i}:00Z`))); // 04:10.. local, quiet
  if (!night.every(no)) { why("night should be blocked " + JSON.stringify(night)); return false; }
  const day = [t(15), t(16), t(17)].map((n) => g.attempt(U(), n));
  const over = g.attempt(U(), t(18));
  if (!day.every(ok) || !no(over)) { why(JSON.stringify([day, over])); return false; }
  if (night[0].reason === over.reason) { why("same code for quiet and cap"); return false; }
  const g2 = bot.createPushGate();
  g2.attempt(U(), t(15)); g2.attempt(U(), t(16)); g2.attempt(U(), t(17));
  const over2 = [g2.attempt(U(), t(18)), g2.attempt(U(), t(19)), g2.attempt(U(), t(20))];
  const next = g2.attempt(U(), D("2026-01-16T15:00:00Z"));
  return over2.every(no) && ok(next);
});
await r.crit("6 users and gates are independent", async (why) => {
  const g = bot.createPushGate();
  for (let i = 0; i < 3; i++) g.attempt(U({ id: "a" }), t(15 + i));
  const a = g.attempt(U({ id: "a" }), t(19));
  const b = g.attempt(U({ id: "b" }), t(19));
  const h = bot.createPushGate();
  const c = h.attempt(U({ id: "a" }), t(19));
  if (!no(a) || !ok(b) || !ok(c)) { why(JSON.stringify([a, b, c])); return false; }
  return true;
});
r.print();
