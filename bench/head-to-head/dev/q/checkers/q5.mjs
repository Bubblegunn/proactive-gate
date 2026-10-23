import { load, Report } from "./lib.mjs";
const dir = process.argv[2];
const NY = "America/New_York";
const U = (id, tz = NY) => ({ userId: id, timeZone: tz });
const D = (s) => new Date(s);
const MIN = 60000;
const fresh = async () => load(dir);
const r = new Report();

// canNudge(...) -> result; if blocked, retryAt must be a real time at which the answer flips to yes, one minute earlier still no
function retryConsistent(b, u, res, why) {
  if (!res || res.allowed !== false) { why("expected a no"); return false; }
  const t = Date.parse(res.retryAt);
  if (typeof res.retryAt !== "string" || isNaN(t)) { why("retryAt missing " + res.retryAt); return false; }
  if (b.canNudge(u, new Date(t)).allowed !== true) { why("not allowed at its own retryAt " + res.retryAt); return false; }
  if (b.canNudge(u, new Date(t - MIN)).allowed !== false) { why("retryAt " + res.retryAt + " is later than needed"); return false; }
  return true;
}
// one nudge cycle: ask, expect yes, record
function nudge(b, id, iso, why) {
  const x = b.canNudge(U(id), D(iso));
  if (!x || x.allowed !== true) { why(`expected yes at ${iso}, got ${JSON.stringify(x)}`); return false; }
  b.recordNudge(id, D(iso));
  return true;
}

await r.crit("1 two nudges less than 4 hours apart are blocked, retryAt is right", async (why) => {
  const b = await fresh();
  if (!nudge(b, "u1", "2026-06-08T13:00:00Z", why)) return false;
  const x = b.canNudge(U("u1"), D("2026-06-08T16:59:00Z"));
  if (!retryConsistent(b, U("u1"), x, why)) return false;
  if (Date.parse(x.retryAt) !== Date.parse("2026-06-08T17:00:00Z")) { why("retryAt " + x.retryAt); return false; }
  return nudge(b, "u1", "2026-06-08T17:00:00Z", why);
});

await r.crit("2 after 3 unanswered nudges: silent for 7 days from the third", async (why) => {
  const b = await fresh();
  for (const t of ["2026-06-08T13:00:00Z", "2026-06-08T17:00:00Z", "2026-06-08T21:00:00Z"]) if (!nudge(b, "u1", t, why)) return false;
  const x = b.canNudge(U("u1"), D("2026-06-09T17:00:00Z"));
  if (!retryConsistent(b, U("u1"), x, why)) return false;
  if (Date.parse(x.retryAt) !== Date.parse("2026-06-15T21:00:00Z")) { why("retryAt " + x.retryAt); return false; }
  if (b.canNudge(U("u1"), D("2026-06-15T20:59:00Z")).allowed !== false) { why("allowed before 7 days"); return false; }
  if (b.canNudge(U("u1"), D("2026-06-15T21:00:00Z")).allowed !== true) { why("blocked after 7 days"); return false; }
  return true;
});

await r.crit("3 a reply restarts the count of unanswered nudges", async (why) => {
  const b = await fresh();
  for (const t of ["2026-06-08T13:00:00Z", "2026-06-08T17:00:00Z"]) if (!nudge(b, "u1", t, why)) return false;
  b.recordReply("u1", D("2026-06-08T18:00:00Z"));
  for (const t of ["2026-06-09T13:00:00Z", "2026-06-09T17:00:00Z", "2026-06-09T21:00:00Z"]) if (!nudge(b, "u1", t, why)) return false;
  const x = b.canNudge(U("u1"), D("2026-06-10T13:00:00Z"));
  if (x.allowed !== false) { why("fourth unanswered nudge after the reply was allowed"); return false; }
  // another user is unaffected
  return b.canNudge(U("u2"), D("2026-06-10T13:00:00Z")).allowed === true;
});

await r.crit("4 a reply during the silent week ends it", async (why) => {
  const b = await fresh();
  for (const t of ["2026-06-08T13:00:00Z", "2026-06-08T17:00:00Z", "2026-06-08T21:00:00Z"]) if (!nudge(b, "u1", t, why)) return false;
  if (b.canNudge(U("u1"), D("2026-06-10T14:00:00Z")).allowed !== false) { why("not silent during the week"); return false; }
  b.recordReply("u1", D("2026-06-10T15:00:00Z"));
  const x = b.canNudge(U("u1"), D("2026-06-10T17:00:00Z"));
  if (x.allowed !== true) { why("still blocked after the user wrote " + JSON.stringify(x)); return false; }
  return true;
});

await r.crit("5 canNudge changes nothing, however often it is called", async (why) => {
  const b = await fresh();
  const first = b.canNudge(U("u1"), D("2026-06-08T13:00:00Z"));
  if (first.allowed !== true || first.retryAt !== null || first.reason !== "ok") { why("fresh user " + JSON.stringify(first)); return false; }
  for (let i = 0; i < 20; i++) b.canNudge(U("u1"), D("2026-06-08T13:00:00Z"));
  for (const t of ["2026-06-08T13:00:00Z", "2026-06-08T17:00:00Z", "2026-06-08T21:00:00Z"]) if (!nudge(b, "u1", t, why)) return false;
  for (let i = 0; i < 10; i++) b.canNudge(U("u1"), D("2026-06-12T17:00:00Z"));
  if (b.canNudge(U("u1"), D("2026-06-15T21:00:00Z")).allowed !== true) { why("silence got longer by asking"); return false; }
  // blocked asks must not start a gap either: ask at 13:00Z on a user with no nudges, never record, still allowed 1 hour later
  b.canNudge(U("u9"), D("2026-06-08T13:00:00Z"));
  return b.canNudge(U("u9"), D("2026-06-08T14:00:00Z")).allowed === true;
});

await r.crit("6 no nudges at night in the user's own zone; reasons differ", async (why) => {
  const b = await fresh();
  // 03:00 New York = 07:00Z; 16:00 Tokyo at the same instant
  const night = b.canNudge(U("u1"), D("2026-06-08T07:00:00Z"));
  if (!retryConsistent(b, U("u1"), night, why)) return false;
  if (b.canNudge(U("u2", "Asia/Tokyo"), D("2026-06-08T07:00:00Z")).allowed !== true) { why("Tokyo 16:00 blocked"); return false; }
  for (const h of ["06:00", "08:00", "09:00"]) if (b.canNudge(U("u3", "Asia/Tokyo"), D(`2026-06-08T${h}:00Z`)).allowed !== true) { why("Tokyo daytime blocked " + h); return false; }
  if (b.canNudge(U("u3", "Asia/Tokyo"), D("2026-06-08T18:00:00Z")).allowed !== false) { why("Tokyo 03:00 allowed"); return false; }
  if (b.canNudge(U("u1"), D("2026-06-08T16:00:00Z")).allowed !== true) { why("New York noon blocked"); return false; }
  nudge(b, "u4", "2026-06-08T13:00:00Z", () => {});
  const gap = b.canNudge(U("u4"), D("2026-06-08T14:00:00Z"));
  for (const t of ["2026-06-08T17:00:00Z", "2026-06-08T21:00:00Z"]) nudge(b, "u4", t, () => {});
  const susp = b.canNudge(U("u4"), D("2026-06-09T17:00:00Z"));
  const rs = [night.reason, gap.reason, susp.reason];
  if (rs.some((x) => typeof x !== "string" || !x || x === "ok") || new Set(rs).size !== 3) { why("reasons " + rs); return false; }
  return true;
});
r.print();
