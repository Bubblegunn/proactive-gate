import { load, Report } from "./lib.mjs";
const dir = process.argv[2];
const LA = "America/Los_Angeles";
const M = (userId, o = {}) => ({ userId, timeZone: LA, category: "marketing", marketingOptIn: true, ...o });
const T = (userId, o = {}) => M(userId, { category: "transactional", ...o });
const D = (s) => new Date(s);
const fresh = async () => (await load(dir)).decidePush;
const r = new Report();

await r.crit("1 at most 3 marketing pushes in a day, users counted separately", async (why) => {
  const f = await fresh();
  // 2026-06-09 local: 10:00, 12:00, 15:00, then 16:00 (PDT = UTC-7)
  const got = ["2026-06-09T17:00:00Z", "2026-06-09T19:00:00Z", "2026-06-09T22:00:00Z", "2026-06-09T23:00:00Z"].map((t) => f(M("u1"), D(t)));
  if (!got.slice(0, 3).every((x) => x && x.allowed === true)) { why("first three not allowed " + JSON.stringify(got)); return false; }
  if (got[3].allowed !== false) { why("fourth allowed"); return false; }
  if (f(M("u2"), D("2026-06-09T23:00:00Z")).allowed !== true) { why("other user blocked"); return false; }
  return true;
});

await r.crit("2 transactional pushes are never blocked and never use up the marketing quota", async (why) => {
  const f = await fresh();
  for (let i = 0; i < 4; i++) if (f(T("u1"), D(`2026-06-09T${17 + i}:00:00Z`)).allowed !== true) { why("transactional blocked by day " + i); return false; }
  for (let i = 0; i < 3; i++) if (f(M("u1"), D(`2026-06-09T${21 + i}:00:00Z`)).allowed !== true) { why("marketing " + i + " blocked after transactional"); return false; }
  if (f(M("u1"), D("2026-06-09T23:30:00Z")).allowed !== false) { why("4th marketing allowed"); return false; }
  if (f(T("u1"), D("2026-06-09T23:40:00Z")).allowed !== true) { why("transactional blocked once cap is reached"); return false; }
  if (f(T("u1", { marketingOptIn: false }), D("2026-06-10T10:00:00Z")).allowed !== true) { why("transactional at 03:00 local, no opt-in, blocked"); return false; }
  return true;
});

await r.crit("3 the day is the user's local calendar day", async (why) => {
  const f = await fresh();
  // local Jun 10 11:00, 12:00, 13:00 (UTC 18, 19, 20)
  for (const h of ["18", "19", "20"]) if (f(M("u1"), D(`2026-06-10T${h}:00:00Z`)).allowed !== true) { why("setup send blocked"); return false; }
  // local Jun 10 19:00 = 02:00Z Jun 11: new UTC day, same local day
  if (f(M("u1"), D("2026-06-11T02:00:00Z")).allowed !== false) { why("allowed after UTC midnight but same local day"); return false; }
  // local Jun 11 10:30 = 17:30Z: new local day but under 24 hours after the first send
  if (f(M("u1"), D("2026-06-11T17:30:00Z")).allowed !== true) { why("blocked on the next local day"); return false; }
  return true;
});

await r.crit("4 no marketing opt-in: blocked, and the blocked tries do not use quota", async (why) => {
  const f = await fresh();
  for (let i = 0; i < 4; i++) if (f(M("u1", { marketingOptIn: false }), D(`2026-06-09T${17 + i}:00:00Z`)).allowed !== false) { why("sent without opt-in"); return false; }
  for (let i = 0; i < 3; i++) if (f(M("u1", { marketingOptIn: true }), D(`2026-06-09T${21 + i}:00:00Z`)).allowed !== true) { why("quota used up by blocked tries, i=" + i); return false; }
  return true;
});

await r.crit("5 no marketing at night local time, and blocked night tries do not use quota", async (why) => {
  const f = await fresh();
  // 03:00 LA = 10:00Z; 04:00 Tokyo (JST = UTC+9) = 19:00Z the day before
  if (f(M("u1"), D("2026-06-09T10:00:00Z")).allowed !== false) { why("LA 03:00 allowed"); return false; }
  if (f(M("u3", { timeZone: "Asia/Tokyo" }), D("2026-06-09T19:00:00Z")).allowed !== false) { why("Tokyo 04:00 allowed"); return false; }
  if (f(M("u3", { timeZone: "Asia/Tokyo" }), D("2026-06-09T03:00:00Z")).allowed !== true) { why("Tokyo 12:00 blocked"); return false; }
  for (const h of ["09:00", "09:30", "10:30", "11:00", "11:30"]) f(M("u4"), D(`2026-06-09T${h}:00Z`));
  for (let i = 0; i < 3; i++) if (f(M("u4"), D(`2026-06-09T${19 + i}:00:00Z`)).allowed !== true) { why("night tries used quota"); return false; }
  return true;
});

await r.crit("6 each cause has its own non-empty reason code, ok when allowed", async (why) => {
  const f = await fresh();
  const ok = f(M("u1"), D("2026-06-09T17:00:00Z"));
  const night = f(M("u1"), D("2026-06-09T10:00:00Z"));
  const optout = f(M("u1", { marketingOptIn: false }), D("2026-06-09T18:00:00Z"));
  f(M("u1"), D("2026-06-09T19:00:00Z")); f(M("u1"), D("2026-06-09T20:00:00Z"));
  const cap = f(M("u1"), D("2026-06-09T21:00:00Z"));
  if (ok.reason !== "ok") { why("allowed reason " + ok.reason); return false; }
  const rs = [night, optout, cap];
  if (rs.some((x) => x.allowed !== false || typeof x.reason !== "string" || !x.reason || x.reason === "ok")) { why("not blocked with a reason " + JSON.stringify(rs)); return false; }
  if (new Set(rs.map((x) => x.reason)).size !== 3) { why("reasons not distinct " + rs.map((x) => x.reason)); return false; }
  return true;
});
r.print();
